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
# Maestro's own launch clears app data first, so this dump is the control: if the
# login markers are on screen here and absent after the flow starts, the difference
# is the wiped first run, not the screen.
adb shell uiautomator dump /sdcard/hierarchy-launch.xml > /dev/null 2>&1
adb shell cat /sdcard/hierarchy-launch.xml > "$RUNNER_TEMP/hierarchy-launch.xml" 2>/dev/null
launch_screen=$(adb shell wm size | tr -d '\r' | awk '{print $NF}')
launch_focus=$(adb shell dumpsys window 2>/dev/null | grep -a mCurrentFocus | head -n 1 | tr -d '\r')
annotate notice "launch smoke" "before Maestro: $(node .github/scripts/mobile-e2e-hierarchy.mjs "$RUNNER_TEMP/hierarchy-launch.xml" "${launch_screen:-unknown}" "ime=n/a") focus=${launch_focus:-unknown}"

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
  # Maestro stops with the failing screen still up, so this dump is the device's
  # own answer to "was that element missing, or only out of sight?".
  adb shell uiautomator dump /sdcard/hierarchy.xml > /dev/null 2>&1
  adb shell cat /sdcard/hierarchy.xml > "$RUNNER_TEMP/hierarchy.xml" 2>/dev/null
  screen=$(adb shell wm size | tr -d '\r' | awk '{print $NF}')
  ime=$(adb shell dumpsys input_method | tr -d '\r' | grep -oE 'mInputShown=(true|false)' | head -n 1)
  annotate error Maestro "what the device showed: $(node .github/scripts/mobile-e2e-hierarchy.mjs "$RUNNER_TEMP/hierarchy.xml" "${screen:-unknown}" "${ime:-unknown}")"
  # A dialog the system drew over the app is a different failure from a widget the
  # app never made, and only the ANR report says which. Its header names the reason
  # and the load; its main-thread block names the code that held the UI thread, so
  # the run can be read as "app blocks" or "device starved" instead of guessed.
  adb logcat -d -b all > "$RUNNER_TEMP/logcat-all.txt" 2>/dev/null
  grep -aE 'ANR in|Subject:|Reason:|Error *:|PID:|Load:|input dispatching|not responding' \
    "$RUNNER_TEMP/logcat-all.txt" > "$RUNNER_TEMP/anr-logcat.txt" 2>/dev/null
  adb shell dumpsys dropbox --print data_app_anr > "$RUNNER_TEMP/anr-dropbox.txt" 2>/dev/null
  {
    echo '### ANR report (dropbox)'
    echo '```'
    tail -n 200 "$RUNNER_TEMP/anr-dropbox.txt"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
  anr_head=$(grep -ahE 'Subject:|Reason:|Load:|not responding|Waiting for ' \
    "$RUNNER_TEMP/anr-dropbox.txt" "$RUNNER_TEMP/anr-logcat.txt" 2>/dev/null |
    sed -E 's/^[0-9-]+ [0-9:.]+ +[0-9]+ +[0-9]+ [A-Z] [A-Za-z/]+: //' | tail -n 5 | tr -d '\r')
  annotate error "Maestro ANR" "why the device stopped: ${anr_head:-no ANR line in logcat or dropbox}"
  # The main thread is the one that matters: idle in the looper means the process
  # was starved, and a named frame means our code held it.
  anr_main=$(awk '/^[ \t]*"main"/{f=1} f && /^[ \t]*$/{exit} f{print}' "$RUNNER_TEMP/anr-dropbox.txt" 2>/dev/null | head -n 14 | tr -d '\r')
  annotate error "Maestro main thread" "main thread at the ANR: ${anr_main:-no main-thread block in the dropbox entry}"
  pid=$(adb shell pidof com.openbridge.mobile | tr -d '\r')
  focus=$(adb shell dumpsys window 2>/dev/null | grep -aE 'mCurrentFocus|mFocusedApp' | head -n 2 | tr -d '\r' | tr '\n' ' ')
  # Host saturation is the other half of the starvation question: the emulator, the
  # Gradle daemon, the API and Maestro all share this machine's cores.
  annotate notice "device state" "pid=${pid:-gone} focus=${focus:-unknown} host_load=$(cut -d' ' -f1-3 /proc/loadavg) cores=$(nproc)"
  # The verdict is already recorded, so this probe cannot turn a red run green: it
  # cold-starts once more and waits far longer than Maestro did, which separates a
  # screen that never arrives from one that only arrives late. If the login markers
  # appear here, the device has an answer about the pinned footer in the same run.
  adb shell am force-stop com.openbridge.mobile
  adb shell am start -n com.openbridge.mobile/.MainActivity > "$RUNNER_TEMP/relaunch.log" 2>&1
  sleep 20
  adb shell uiautomator dump /sdcard/hierarchy-settled.xml > /dev/null 2>&1
  adb shell cat /sdcard/hierarchy-settled.xml > "$RUNNER_TEMP/hierarchy-settled.xml" 2>/dev/null
  annotate notice "settled probe" "after a 20s cold start: $(node .github/scripts/mobile-e2e-hierarchy.mjs "$RUNNER_TEMP/hierarchy-settled.xml" "${launch_screen:-unknown}" "$(adb shell dumpsys input_method | tr -d '\r' | grep -oE 'mInputShown=(true|false)' | head -n 1)") relaunch=$(tr -d '\r' < "$RUNNER_TEMP/relaunch.log" | tail -n 2)"
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
