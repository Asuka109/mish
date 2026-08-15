import { describe, expect, it } from "vitest";

import { EventQueue } from "../src/session.js";

describe("renderer event queue", () => {
  it("rejects pending and future reads on bounded overflow without an uncaught throw", async () => {
    const queue = new EventQueue<number>(1);
    const pending = queue.next();
    const error = new Error("Electron event queue exceeded its bound");
    queue.close(error);
    await expect(pending).rejects.toBe(error);
    await expect(queue.next()).rejects.toThrow(error.message);

    const bounded = new EventQueue<number>(1);
    bounded.push(1);
    bounded.push(2);
    await expect(bounded.next()).resolves.toEqual({ done: false, value: 1 });
    await expect(bounded.next()).rejects.toThrow(error.message);
  });

  it("settles a waiter when the stream closes normally", async () => {
    const queue = new EventQueue<number>(2);
    const pending = queue.next();
    queue.close();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expect(queue.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
