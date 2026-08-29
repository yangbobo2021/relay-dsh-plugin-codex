export function workspaceImportUiPolicy(phase, selected = 0, failed = 0) {
  if (phase === "importing") {
    return Object.freeze({ canClose: false, primary: "importing", primaryDisabled: true });
  }
  if (phase === "summary") {
    return Object.freeze({
      canClose: true,
      secondary: "cancel",
      primary: "import-selected",
      primaryDisabled: selected === 0,
    });
  }
  if (phase === "error") {
    return Object.freeze({ canClose: true, secondary: "cancel", primary: "retry", primaryDisabled: false });
  }
  if (phase === "complete" && failed > 0) {
    return Object.freeze({ canClose: true, secondary: "close", primary: "retry", primaryDisabled: false });
  }
  return Object.freeze({ canClose: true, primary: "close", primaryDisabled: false });
}

export function workspaceImportUpdatedAtDate(value) {
  if (value === null || value === undefined) return null;
  const milliseconds = typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e12
    ? value * 1000
    : value;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date;
}
