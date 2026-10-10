// 求解 Web Worker：后台搜索，避免阻塞 UI
import { solvePuzzle } from "./solver.js";

self.onmessage = (e) => {
  const { id, puzzle, mode, timeoutMs } = e.data;
  try {
    const res = solvePuzzle(puzzle, { mode: mode || "one", timeoutMs: timeoutMs || 10000 });
    self.postMessage({ id, ...res });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
