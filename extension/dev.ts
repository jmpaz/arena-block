import { watch } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
let building = false;
let pending = false;
let timer: ReturnType<typeof setTimeout> | undefined;

async function build(): Promise<void> {
  if (building) { pending = true; return; }
  building = true;
  do {
    pending = false;
    const process = Bun.spawn(["bun", "run", join(import.meta.dir, "build.ts")], { cwd: root, stdout: "inherit", stderr: "inherit" });
    await process.exited;
  } while (pending);
  building = false;
}

await build();
for (const directory of [join(import.meta.dir, "src"), join(root, "packages", "core")]) {
  watch(directory, { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void build(); }, 120);
  });
}
for (const file of [join(import.meta.dir, "build.ts"), join(root, "scripts", "generate-icons.ts"), join(root, "assets", "mark.svg")]) {
  watch(file, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void build(); }, 120);
  });
}
console.log("Watching extension UI and shared core; reload the unpacked extension after each build.");
