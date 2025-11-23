import { describe, it, expect } from "vitest";
import { TaskQueue, TaskHandleHolder, TaskHandle } from "../src/core/task_queue";

describe("TaskQueue - ordering and basic behavior", () => {
  it("runs lower numerical priorities first", () => {
    const q = new TaskQueue({ autoFlush: false });
    const order: number[] = [];

    q.submit(() => order.push(1), 1);
    q.submit(() => order.push(0), 0);
    q.submit(() => order.push(2), 2);

    q.flush();
    expect(order).toEqual([0, 1, 2]);
  });

  it("is FIFO for tasks with equal priority", () => {
    const q = new TaskQueue({ autoFlush: false });
    const calls: string[] = [];

    q.submit(() => calls.push("A"), 5);
    q.submit(() => calls.push("B"), 5);
    q.submit(() => calls.push("C"), 5);

    q.flush();
    expect(calls).toEqual(["A", "B", "C"]);
  });

  it("auto-flush runs tasks asynchronously by default", async () => {
    const q = new TaskQueue();
    let ran = false;
    q.submit(() => {
      ran = true;
    }, 0);

    expect(ran).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toBe(true);
  });

  it("cancel prevents execution if still pending", () => {
    const q = new TaskQueue({ autoFlush: false });
    const calls: string[] = [];

    const holder1 = new TaskHandleHolder();
    const holder2 = new TaskHandleHolder();
    q.submit(() => calls.push("A"), 0, holder1);
    q.submit(() => calls.push("B"), 0, holder2);
    const h1 = holder1.getHandles()[0] as TaskHandle;
    const h2 = holder2.getHandles()[0] as TaskHandle;
    const cancelled = h2.cancel();

    expect(cancelled).toBe(true);
    expect(h2.isCancelled()).toBe(true);
    expect(h2.isPending()).toBe(false);
    expect(h2.isCompleted()).toBe(false);

    q.flush();
    expect(calls).toEqual(["A"]);
    expect(h1.isCompleted()).toBe(true);
    expect(h1.isRunning()).toBe(false);
  });

  it("self-cancel inside callback is a no-op and returns false", () => {
    const q = new TaskQueue({ autoFlush: false });
    let handle: TaskHandle;
    let cancelResult: boolean | undefined;
    let ran = false;

    const holder = new TaskHandleHolder();
    q.submit(
      () => {
        // At this point, the task is running; cancelling should fail and not change state
        cancelResult = handle.cancel();
        ran = true;
      },
      0,
      holder,
    );
    handle = holder.getHandles()[0] as TaskHandle;

    q.flush();
    expect(ran).toBe(true);
    expect(cancelResult).toBe(false);
    expect(handle.isCompleted()).toBe(true);
    expect(handle.isRunning()).toBe(false);
    expect(handle.isCancelled()).toBe(false);
    expect(handle.isPending()).toBe(false);
  });

  it("submitWeak executes when reference is still strongly held", () => {
    const q = new TaskQueue({ autoFlush: false });
    const calls: number[] = [];
    const fn = () => calls.push(1);
    const holder = new TaskHandleHolder();
    q.submitWeak(fn, 0, holder);
    const h = holder.getHandles()[0] as TaskHandle;
    expect(h?.isPending?.()).toBe(true);
    q.flush();
    expect(calls).toEqual([1]);
    expect(h.isCompleted()).toBe(true);
  });

  it("cancelAll cancels all pending tasks and empties the holder", () => {
    const q = new TaskQueue({ autoFlush: false });
    const holder = new TaskHandleHolder();
    const calls: number[] = [];

    // Enqueue multiple tasks into the same holder
    for (let i = 0; i < 5; i++) {
      q.submit(() => calls.push(i), 0, holder);
    }
    expect(holder.size).toBe(5);
    holder.getHandles().forEach((h) => expect(h.isPending()).toBe(true));

    // Snapshot handles for post-cancel state checks
    const handles = holder.getHandles().map((h) => h as TaskHandle);

    holder.cancelAll();
    expect(holder.size).toBe(0);
    handles.forEach((h) => expect(h.isCancelled()).toBe(true));

    // Flushing should run nothing
    q.flush();
    expect(calls).toEqual([]);
  });
});

describe("TaskQueue - Monte Carlo randomized scenario", () => {
  it("maintains correct ordering and state across random ops", () => {
    const q = new TaskQueue({ autoFlush: false });
    type Model = {
      id: number;
      priority: number;
      submitSeq: number;
      handle: TaskHandle;
      cancelledBeforeRun: boolean;
      willSelfCancel: boolean;
      ran: boolean;
    };

    const models: Model[] = [];
    const executed: number[] = [];
    let submitSeq = 0;
    let nextId = 1;

    const random = (max: number) => Math.floor(Math.random() * max);
    const NUM_OPS = 200;

    for (let i = 0; i < NUM_OPS; i++) {
      const op = Math.random();
      if (op < 0.6 || models.length === 0) {
        // add task (strong or weak)
        const priority = random(5); // 0..4
        const willSelfCancel = Math.random() < 0.2;
        const id = nextId++;
        const seq = submitSeq++;
        let handle: TaskHandle;
        const cb = () => {
          // Optionally attempt to cancel self; should return false while running
          if (willSelfCancel) {
            const res = handle.cancel();
            expect(res).toBe(false);
          }
          executed.push(id);
        };
        const holder = new TaskHandleHolder();
        if (Math.random() < 0.5) {
          q.submit(cb, priority, holder);
        } else {
          q.submitWeak(cb, priority, holder);
        }
        handle = holder.getHandles()[0] as TaskHandle;
        models.push({
          id,
          priority,
          submitSeq: seq,
          handle,
          cancelledBeforeRun: false,
          willSelfCancel,
          ran: false,
        });
      } else {
        // attempt to cancel a random pending task
        const pending = models.filter((m) => m.handle.isPending());
        if (pending.length > 0) {
          const pick = pending[random(pending.length)];
          const res = pick.handle.cancel();
          if (res) {
            pick.cancelledBeforeRun = true;
          }
        }
      }
    }

    q.flush();

    // Determine expected executed models (not cancelled before run)
    const expectedExecuted = models
      .filter((m) => !m.cancelledBeforeRun)
      .sort((a, b) => a.priority - b.priority || a.submitSeq - b.submitSeq)
      .map((m) => m.id);

    expect(executed).toEqual(expectedExecuted);

    // Validate final states
    for (const m of models) {
      if (m.cancelledBeforeRun) {
        expect(m.handle.isCancelled()).toBe(true);
        expect(m.handle.isPending()).toBe(false);
        expect(m.handle.isCompleted()).toBe(false);
        expect(m.handle.isRunning()).toBe(false);
      } else {
        expect(m.handle.isCompleted()).toBe(true);
        expect(m.handle.isRunning()).toBe(false);
        expect(m.handle.isCancelled()).toBe(false);
        expect(m.handle.isPending()).toBe(false);
      }
    }
  });
});
