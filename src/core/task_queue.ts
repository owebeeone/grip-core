/**
* GRIP Task Queue - Priority-based task scheduling and execution
* 
* Implements a small, self-contained, extensible task queue with priority ordering
* and support for weakly-held callbacks. Provides the foundation for asynchronous
* task execution throughout the GRIP system.
* 
* Key Features:
* - Priority-based task ordering (lower numeric priority runs first)
* - Stable FIFO ordering for tasks with equal priority
* - Auto-flush on next microtask by default
* - Weak submission that drops tasks if callbacks are GC'd
* - Cancellation support via returned handles
* - No external dependencies
* 
* Design Goals:
* - Stable ordering for tasks with equal priority (FIFO for same priority)
* - Auto-flush on next microtask by default; optionally manual flush
* - Weak submission drops tasks if callback is GC'd before execution
* - Cancellation support via returned handle
* - No external dependencies; idiomatic TypeScript
* 
* Use Cases:
* - Deferred graph updates and evaluations
* - Batched operations and optimizations
* - Asynchronous Tap lifecycle management
* - Priority-based task scheduling
*/

/**
* Function signature for task callbacks.
*/
export type TaskCallback = () => void;

/**
* Interface for task handles that provide cancellation and status information.
* 
* Task handles allow tasks to be cancelled before execution and provide
* status information about the task's current state.
*/
export interface TaskHandle {
/**
* Cancels the task if it hasn't started executing.
* 
* @returns True if the task was cancelled, false if it was already running/completed
*/
cancel(): boolean;

/**
* Checks if the task is currently running.
* 
* @returns True if the task is currently executing
*/
isRunning(): boolean;

/**
* Checks if the task has been cancelled.
* 
* @returns True if the task was cancelled
*/
isCancelled(): boolean;

/**
* Checks if the task is pending execution.
* 
* @returns True if the task is waiting to be executed
*/
isPending(): boolean;

/**
* Checks if the task has completed execution.
* 
* @returns True if the task has finished executing
*/
isCompleted(): boolean;
}

/**
* Interface for a container that can hold TaskHandles.
* 
* Provides a way to group and manage multiple task handles together,
* enabling bulk operations like cancellation of all tasks in a group.
*/
export interface TaskHandleContainer {
/**
* Adds a task handle to the container.
* 
* @param handle - The task handle to add
*/
add(handle: TaskHandle): void;

/**
* Removes a task handle from the container.
* 
* @param handle - The task handle to remove
*/
remove(handle: TaskHandle): void;
}

/**
* A container for TaskHandles implementing the TaskHandleContainer interface.
* 
* Provides convenient methods for managing collections of task handles,
* including bulk cancellation and size tracking.
*/
export class TaskHandleHolder implements TaskHandleContainer {
private readonly handles: TaskHandle[] = [];

/**
* Adds a task handle to the container.
* 
* @param handle - The task handle to add
*/
add(handle: TaskHandle): void {
this.handles.push(handle);
}

/**
* Removes a task handle from the container.
* 
* @param handle - The task handle to remove
*/
remove(handle: TaskHandle): void {
const idx = this.handles.indexOf(handle);
if (idx >= 0) this.handles.splice(idx, 1);
}

/**
* Gets all task handles in the container.
* 
* @returns Read-only array of all task handles
*/
getHandles(): ReadonlyArray<TaskHandle> {
return this.handles;
}

/**
* Gets the number of task handles in the container.
* 
* @returns The number of task handles
*/
get size(): number {
return this.handles.length;
}

/**
* Cancels all task handles in the container.
* 
* Iterates through all handles and cancels them, removing them
* from the container as they are cancelled.
*/
cancelAll(): void {
while (this.handles.length > 0) {
this.handles[0].cancel();
}
}
}

/**
* Configuration options for the TaskQueue.
* 
* @property autoFlush - When true (default), a flush is scheduled automatically on submit
* @property useMicrotask - When true (default), use queueMicrotask; otherwise falls back to setTimeout(0)
*/
export interface TaskQueueOptions {
// When true (default), a flush is scheduled automatically on submit.
autoFlush?: boolean;
// When true (default), use queueMicrotask; otherwise falls back to setTimeout(0).
useMicrotask?: boolean;
}

/**
* The possible states of a task.
*/
type TaskState = "pending" | "running" | "completed" | "cancelled";

/**
* Internal representation of a task in the queue.
* 
* Contains all the information needed to execute and manage a task,
* including its priority, callback, and current state.
*/
interface InternalTask {
id: number;
priority: number;
// Stable tie-breaker to preserve FIFO for equal priority
sequence: number;
// Exactly one of these is set
strongCallback?: TaskCallback;
weakCallback?: WeakRef<TaskCallback>;
state: TaskState;
handle?: TaskHandleImpl;
}

/**
* A minimal priority queue using a binary min-heap keyed by (priority, sequence).
* 
* Provides stable ordering for tasks with the same priority by using
* a sequence number as a tie-breaker. Lower priority values are executed first.
*/
class MinHeap {
private items: InternalTask[] = [];

/**
* Gets the number of items in the heap.
* 
* @returns The number of items
*/
get size(): number {
return this.items.length;
}

/**
* Adds a task to the heap.
* 
* @param task - The task to add
*/
push(task: InternalTask): void {
this.items.push(task);
this.bubbleUp(this.items.length - 1);
}

/**
* Gets the highest priority task without removing it.
* 
* @returns The highest priority task or undefined if empty
*/
peek(): InternalTask | undefined {
return this.items[0];
}

/**
* Removes and returns the highest priority task from the heap.
* 
* @returns The highest priority task or undefined if empty
*/
pop(): InternalTask | undefined {
if (this.items.length === 0) return undefined;
const top = this.items[0];
const end = this.items.pop()!;
if (this.items.length > 0) {
this.items[0] = end;
this.bubbleDown(0);
}
return top;
}

private less(a: InternalTask, b: InternalTask): boolean {
if (a.priority !== b.priority) return a.priority < b.priority;
return a.sequence < b.sequence;
}

private bubbleUp(index: number): void {
while (index > 0) {
const parent = Math.floor((index - 1) / 2);
if (!this.less(this.items[index], this.items[parent])) break;
this.swap(index, parent);
index = parent;
}
}

private bubbleDown(index: number): void {
const length = this.items.length;
while (true) {
const left = index * 2 + 1;
const right = index * 2 + 2;
let smallest = index;
if (left < length && this.less(this.items[left], this.items[smallest])) {
smallest = left;
}
if (right < length && this.less(this.items[right], this.items[smallest])) {
smallest = right;
}
if (smallest === index) break;
this.swap(index, smallest);
index = smallest;
}
}

private swap(i: number, j: number): void {
const tmp = this.items[i];
this.items[i] = this.items[j];
this.items[j] = tmp;
}
}

/**
* A priority-based task queue for asynchronous task execution.
* 
* The TaskQueue provides a robust foundation for scheduling and executing
* tasks with priority ordering. It supports both strong and weak references
* to callbacks, automatic flushing, and comprehensive error handling.
* 
* Key Features:
* - Priority-based task ordering (lower numbers run first)
* - Stable FIFO ordering for equal priority tasks
* - Automatic flushing with microtask scheduling
* - Weak reference support for GC-friendly task submission
* - Comprehensive error handling and reporting
* - Task cancellation and status tracking
*/
export class TaskQueue {
private readonly heap: MinHeap = new MinHeap();
private readonly options: Required<TaskQueueOptions>;
private nextId = 1;
private nextSequence = 1;
private scheduled: boolean = false;
private isFlushing: boolean = false;

/**
* Creates a new TaskQueue with the specified options.
* 
* @param options - Configuration options for the task queue
*/
constructor(options?: TaskQueueOptions) {
this.options = {
autoFlush: options?.autoFlush ?? true,
useMicrotask: options?.useMicrotask ?? true,
};
}

/**
* Gets the number of tasks currently queued.
* 
* Includes cancelled and unresolvable weak tasks that haven't been cleaned up yet.
* 
* @returns The number of tasks in the queue
*/
get size(): number {
return this.heap.size;
}

/**
* Submits a task with an optional priority.
* 
* Lower priority numbers run first. If a holder is provided, a handle is created
* and stored there for cancellation and status tracking.
* 
* @param callback - The task function to execute
* @param priority - Priority level (default: 0, lower numbers run first)
* @param holder - Optional container to store the task handle
*/
submit(callback: TaskCallback, priority: number = 0, holder?: TaskHandleContainer): void {
const task: InternalTask = {
id: this.nextId++,
priority,
sequence: this.nextSequence++,
strongCallback: callback,
state: "pending",
};
if (holder) {
task.handle = this.createHandle(task, holder);
}
this.heap.push(task);
this.scheduleFlushIfNeeded();
}

/**
* Submits a task held via WeakRef.
* 
* If the callback is garbage collected before execution, the task is dropped
* silently. This is useful for preventing memory leaks when tasks reference
* objects that may be garbage collected.
* 
* If WeakRef is not available in the runtime, this falls back to a strong
* submission to preserve functionality.
* 
* @param callback - The task function to execute
* @param priority - Priority level (default: 0, lower numbers run first)
* @param holder - Optional container to store the task handle
*/
submitWeak(callback: TaskCallback, priority: number = 0, holder?: TaskHandleContainer): void {
if (typeof WeakRef === "undefined") {
// Fallback: no WeakRef support, degrade to strong reference
this.submit(callback, priority, holder);
return;
}
const task: InternalTask = {
id: this.nextId++,
priority,
sequence: this.nextSequence++,
weakCallback: new WeakRef(callback),
state: "pending",
};
if (holder) {
task.handle = this.createHandle(task, holder);
}
this.heap.push(task);
this.scheduleFlushIfNeeded();
}

/**
* Executes all queued tasks immediately in priority order.
* 
* Processes all tasks in the queue, executing them in priority order
* (lowest priority first). Handles weak references, cancellation,
* and error reporting automatically.
*/
flush(): void {
if (this.isFlushing) return; // Prevent re-entrant flush cycles
this.isFlushing = true;
try {
// Process until we exhaust the heap
while (true) {
const task = this.heap.pop();
if (!task) break;
if (task.state === "cancelled") continue;

const fn = task.strongCallback ?? task.weakCallback?.deref();
if (!fn) {
// Weak callback GC'd; drop the task as completed (no-op)
if (task.state === "pending") task.handle?.notifyNoLongerPending();
task.state = "completed";
continue;
}

try {
if (task.state === "pending") task.handle?.notifyNoLongerPending();
task.state = "running";
fn();
task.state = "completed";
} catch (err) {
// Surface errors asynchronously to avoid breaking the flush loop
// while still being observable by the host environment.
this.reportAsyncError(err);
// Mark as completed even if it threw; the task has finished its turn
task.state = "completed";
}
}
} finally {
this.isFlushing = false;
this.scheduled = false;
}
}

/** Cancel any scheduled but not-yet-executed auto-flush. */
cancelScheduledFlush(): void {
// No external timer handle because we rely on queueMicrotask/setTimeout
// which cannot be unscheduled without a handle. We simply mark as not
// scheduled when appropriate. If a microtask is already enqueued it will
// execute, but the guard at the start of flush() prevents re-entrancy.
this.scheduled = false;
}

private createHandle(task: InternalTask, holder: TaskHandleContainer): TaskHandleImpl {
const handle = new TaskHandleImpl(task, holder);
holder.add(handle);
return handle;
}

private scheduleFlushIfNeeded(): void {
if (!this.options.autoFlush) return;
if (this.scheduled || this.isFlushing) return;
this.scheduled = true;
if (this.options.useMicrotask && typeof queueMicrotask === "function") {
queueMicrotask(() => this.flush());
} else {
setTimeout(() => this.flush(), 0);
}
}

private reportAsyncError(error: unknown): void {
// Best-effort async error reporting without throwing inside the flush loop
setTimeout(() => {
throw error;
}, 0);
}
}

/**
* A task handle.
*
* Represents the queued task.
*/
class TaskHandleImpl implements TaskHandle {
private readonly task: InternalTask;
private readonly holder: TaskHandleContainer;
private removed = false;

constructor(task: InternalTask, holder: TaskHandleContainer) {
this.task = task;
this.holder = holder;
}

cancel(): boolean {
if (this.task.state !== "pending") return false;
this.task.state = "cancelled";
this.notifyNoLongerPending();
return true;
}

isRunning(): boolean {
return this.task.state === "running";
}
isCancelled(): boolean {
return this.task.state === "cancelled";
}
isPending(): boolean {
return this.task.state === "pending";
}
isCompleted(): boolean {
return this.task.state === "completed";
}

notifyNoLongerPending(): void {
if (this.removed) return;
try {
this.holder.remove(this);
} finally {
this.removed = true;
}
}
}
