// An annotation is the only failure detail readable without a signed-in job log,
// so this condenses a uiautomator dump into one line: the testIDs the device
// actually had on screen, their bounds, and whether the user could see them.
import { readFileSync } from 'node:fs';

const [, , dumpPath, screen, ime] = process.argv;

let xml = '';
try {
  xml = readFileSync(dumpPath, 'utf8');
} catch {
  // No dump means the device never answered; say so in the line itself.
  console.log(`screen=${screen} ime=${ime} nodes=NO DUMP`);
  process.exit(0);
}

const nodes = [];
let hidden = 0;
for (const [, tag] of xml.matchAll(/<node\b([^>]*)>/g)) {
  // Android writes testIDs as `package:id/name`; some builds report the bare
  // name, so accept both shapes rather than silently dropping the node.
  const rawId = /resource-id="([^"]+)"/.exec(tag)?.[1];
  if (!rawId) continue;
  const id = rawId.includes('/') ? rawId.split('/').pop() : rawId;
  const box = /bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/.exec(tag);
  if (!box) continue;
  if (!/visible-to-user="true"/.test(tag)) hidden += 1;
  nodes.push(`${id}@${box[1]},${box[2]}-${box[3]},${box[4]}`);
}

console.log(
  `screen=${screen} ime=${ime} hidden=${hidden} nodes=${nodes.length ? nodes.slice(0, 30).join(' ') : `none (dump ${xml.length} bytes)`}`,
);
