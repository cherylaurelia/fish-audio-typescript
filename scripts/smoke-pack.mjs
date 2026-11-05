#!/usr/bin/env node
// Installs the package the way a user does, then runs what the docs tell them to run.
// Usage: node scripts/smoke-pack.mjs [tarball path or URL]   (default: npm pack of this checkout)
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "fish-audio-smoke-"));
const run = (cmd, args, cwd = dir) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: "pipe" });

let tarball = process.argv[2];
if (!tarball) {
    const [{ filename }] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", dir], root));
    tarball = join(dir, filename);
}
writeFileSync(join(dir, "package.json"), "{}");
run("npm", ["install", "--no-audit", "--no-fund", tarball]);

// The model convert() sends when none is passed must be the one in this checkout's source.
const clientSource = readFileSync(join(root, "src/api/resources/textToSpeech/Client.ts"), "utf8");
const expectedModel = clientSource.match(/backend: Backends = "([^"]+)"/)[1];

async function defaultModel() {
    let model;
    const server = createServer((req, res) => {
        model = req.headers.model;
        req.resume();
        req.on("end", () => res.end("ID3"));
    });
    await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const script = `import { FishAudioClient } from "fish-audio";
await new FishAudioClient({ apiKey: "smoke", baseUrl: "${baseUrl}" }).textToSpeech.convert({ text: "hi" });`;
    writeFileSync(join(dir, "model.mjs"), script);
    // Not execFileSync: the server above has to answer from this process.
    await new Promise((done, fail) => {
        spawn("node", ["model.mjs"], { cwd: dir, stdio: "ignore" }).on("exit", (code) =>
            code === 0 ? done() : fail(new Error(`exit ${code}`)),
        );
    });
    server.close();
    if (model !== expectedModel) throw new Error(`sent ${model}, source says ${expectedModel}`);
}

// The JavaScript quickstart from docs.fish.audio, type-checked as a TypeScript user would.
function quickstartTypes() {
    writeFileSync(
        join(dir, "quickstart.ts"),
        `import { FishAudioClient } from "fish-audio";
const fishAudio = new FishAudioClient({ apiKey: process.env.FISH_API_KEY });
export const audio = await fishAudio.textToSpeech.convert({ text: "Hello, world!" }, "s2.1-pro-free");
`,
    );
    run(join(root, "node_modules/.bin/tsc"), [
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target", "es2022",
        "--module", "esnext",
        "--moduleResolution", "bundler",
        "--typeRoots", join(root, "node_modules/@types"),
        "--types", "node",
        "quickstart.ts",
    ]);
}

const checks = {
    "require('fish-audio')": () => run("node", ["-e", "require('fish-audio').FishAudioClient.name"]),
    "import 'fish-audio'": () =>
        run("node", ["--input-type=module", "-e", "(await import('fish-audio')).FishAudioClient.name"]),
    "docs quickstart type-checks": quickstartTypes,
    "default model matches source": defaultModel,
};

let failed = 0;
for (const [name, check] of Object.entries(checks)) {
    try {
        await check();
        console.log(`ok    ${name}`);
    } catch (error) {
        failed += 1;
        const detail = `${error.stdout ?? ""}${error.stderr ?? ""}` || error.message;
        const line = detail.split("\n").find((text) => /^\w*Error:|error TS/.test(text)) ?? detail.split("\n")[0];
        console.log(`FAIL  ${name}: ${line.trim()}`);
    }
}
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
