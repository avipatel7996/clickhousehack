import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const envFile = existsSync(".env.local") ? ".env.local" : existsSync(".env.example") ? ".env.example" : null;
const args = [];
if (envFile) args.push(`--env-file=${envFile}`);
args.push("node_modules/next/dist/bin/next", "dev", "apps/web");
const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
child.on("exit", (code, signal) => process.exitCode = signal ? 1 : (code ?? 1));
