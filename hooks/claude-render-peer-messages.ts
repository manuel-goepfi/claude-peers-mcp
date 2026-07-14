#!/usr/bin/env bun
import { renderInboundLine } from "../shared/render.ts";
import type { Message } from "../shared/types.ts";

const input = await Bun.stdin.text();
const parsed = JSON.parse(input) as { messages?: Message[] };
if (!Array.isArray(parsed.messages)) process.exit(1);
process.stdout.write(parsed.messages.map(renderInboundLine).join("\n"));
