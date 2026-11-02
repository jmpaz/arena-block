import { expect, test } from "bun:test";
import { inspectAudio } from "../src/audio-inspection.ts";

const stream = (text: string) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
const open = () => new ReadableStream<Uint8Array>();

test("bounded inspection returns output after known child exit without signalling", async () => {
  let kills = 0;
  expect(await inspectAudio(["fake"], undefined, { spawn: () => ({ stdout: stream("complete"), stderr: stream(""),
    exited: Promise.resolve(0), kill() { kills++; } }) })).toBe("complete");
  expect(kills).toBe(0);
});

test("output overflow stops the owned child and waits for its exit", async () => {
  let kills = 0, settle!: (status: number) => void;
  const exited = new Promise<number>(resolve => { settle = resolve; });
  await expect(inspectAudio(["fake"], undefined, { outputBytes: 8, spawn: () => ({ stdout: stream("overflow output"), stderr: open(), exited,
    kill() { kills++; settle(137); } }) })).rejects.toThrow("output exceeded");
  expect(kills).toBe(1);
});

test("own deadline and bounded uncertain settlement cannot wait forever", async () => {
  let kills = 0;
  await expect(inspectAudio(["fake"], undefined, { timeoutMs: 5, settleMs: 5,
    spawn: () => ({ stdout: open(), stderr: open(), exited: new Promise<number>(() => {}), kill() { kills++; } }) }))
    .rejects.toThrow("settlement is uncertain");
  expect(kills).toBe(1);
});

test("an exited leader with an open output pipe is never signalled after exit", async () => {
  let kills = 0;
  await expect(inspectAudio(["fake"], undefined, { timeoutMs: 5,
    spawn: () => ({ stdout: open(), stderr: open(), exited: Promise.resolve(0), kill() { kills++; } }) })).rejects.toThrow();
  expect(kills).toBe(0);
});

test("cancellation settles the owned child and uncertain status never triggers a late signal", async () => {
  let kills = 0, settle!: (status: number) => void;
  const controller = new AbortController(), exited = new Promise<number>(resolve => { settle = resolve; });
  const pending = inspectAudio(["fake"], controller.signal, { spawn: () => ({ stdout: open(), stderr: open(), exited,
    kill() { kills++; settle(137); } }) });
  controller.abort(new Error("cancelled inspection"));
  await expect(pending).rejects.toThrow("cancelled inspection"); expect(kills).toBe(1);
  kills = 0;
  await expect(inspectAudio(["fake"], undefined, { spawn: () => ({ stdout: stream(""), stderr: stream(""), exited: Promise.reject(new Error("unknown")),
    kill() { kills++; } }) })).rejects.toThrow("status is uncertain");
  expect(kills).toBe(0);
});
