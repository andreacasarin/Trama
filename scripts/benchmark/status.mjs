export function benchmarkReportExitCode(status) {
  return status === "completed" ? 0 : 1;
}
