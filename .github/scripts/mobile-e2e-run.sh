#!/usr/bin/env bash
# The emulator runner (android-emulator-runner@v2) executes its `script:` input
# one line per `sh -c`, so blocks like { ... } and if/then cannot be inlined in
# ci.yml; the workflow calls this file as a single command instead.
set +e
APK=mobile/android/app/build/outputs/apk/release/app-release.apk

# An annotation is the only failure detail readable without a signed-in job log,
# so the crash reason has to leave the log and travel as one single-line echo.
annotate() {
  level=$1; title=$2; shift 2
  text=$(printf '%s' "$*" | tr -d '\r' | sed -e 's/%/%25/g' | tr '\n' '|' | tail -c 1200)
  echo "::${level} title=${title}::${text}"
}

{
  echo '## Maestro run'
  echo "sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
  echo "maestro=$(maestro --version 2>&1 | tail -n 1)"
} >> "$GITHUB_STEP_SUMMARY"

# Boot and install are reported separately: when the job fails before
# the first Maestro attempt, the old script left no trace of why.
echo '### phase 1: device'
adb wait-for-device
echo "boot_completed=$(adb shell getprop sys.boot_completed | tr -d '\r')"
adb devices -l
if [ ! -f "$APK" ]; then
  echo "::error title=Maestro::APK not found at $APK"
  ls -R mobile/android/app/build/outputs/apk || true
  exit 1
fi

echo '### phase 2: install'
install_log="$RUNNER_TEMP/adb-install.log"
adb install -r "$APK" > "$install_log" 2>&1
install_status=$?
cat "$install_log"
if [ $install_status -ne 0 ]; then
  echo "::error title=Maestro::APK install failed (exit $install_status)"
  adb logcat -d > "$RUNNER_TEMP/logcat.txt"
  exit 1
fi

echo '### phase 3: launch smoke'
adb logcat -c
adb shell am start -n com.openbridge.mobile/.MainActivity > "$RUNNER_TEMP/launch.log" 2>&1
echo "am start exit=$?"
cat "$RUNNER_TEMP/launch.log"
sleep 5
if adb shell pidof com.openbridge.mobile; then
  echo "app process is running after launch"
else
  # Either the activity name is wrong or the process died on its own; the two
  # look identical from here, so report what the device actually said.
  crash=$(adb logcat -d -s AndroidRuntime:E ReactNativeJS:E ActivityTaskManager:I |
    grep -Ei 'FATAL|Unable to start|does not exist|Error type|ReactNativeJS' | tail -n 6)
  annotate warning Maestro "app process not running five seconds after launch; am start: $(cat "$RUNNER_TEMP/launch.log") crash lines: $crash"
fi
adb logcat -d > "$RUNNER_TEMP/logcat-launch.txt"
adb exec-out screencap -p > "$RUNNER_TEMP/launch.png" || true

echo '### phase 4: flow'
maestro test --format junit --debug-output "$RUNNER_TEMP/maestro-debug" \
  --output "$RUNNER_TEMP/maestro-report-1.xml" mobile/.maestro > "$RUNNER_TEMP/maestro-1.log" 2>&1
status=$?
if [ $status -ne 0 ]; then
  echo "First Maestro attempt failed; retrying once"
  maestro test --format junit --debug-output "$RUNNER_TEMP/maestro-debug" \
    --output "$RUNNER_TEMP/maestro-report-2.xml" mobile/.maestro > "$RUNNER_TEMP/maestro-2.log" 2>&1
  status=$?
fi
adb logcat -d > "$RUNNER_TEMP/logcat.txt"
if [ $status -ne 0 ]; then
  adb exec-out screencap -p > "$RUNNER_TEMP/emulator-failure.png" || true
  {
    echo '## Maestro failure'
    echo '### Attempt 1 (last 80 lines)'
    echo '```'
    tail -n 80 "$RUNNER_TEMP/maestro-1.log"
    echo '```'
    echo '### Attempt 2 (last 40 lines)'
    echo '```'
    tail -n 40 "$RUNNER_TEMP/maestro-2.log"
    echo '```'
    echo '### ReactNativeJS and crashes'
    echo '```'
    adb logcat -d -s ReactNativeJS:E AndroidRuntime:E | tail -n 60
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
  first=$(grep -m1 -E 'Element not found|Assertion|FAILED|Error|not found' "$RUNNER_TEMP/maestro-1.log" | head -c 600)
  echo "::error title=Maestro::Attempt 1: ${first}"
  crash=$(adb logcat -d -s AndroidRuntime:E ReactNativeJS:E | tail -n 10)
  annotate error Maestro "flow output after the failure: $crash"
fi
exit $status
