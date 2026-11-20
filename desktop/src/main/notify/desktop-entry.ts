/** One Exec argument per the Desktop Entry spec: quoted, with its reserved characters escaped. */
export function quoteExecArg(a: string): string {
  return `"${a.replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%')}"`;
}

export function autostartEntry(exec: string[], name: string): string {
  return `[Desktop Entry]\nType=Application\nName=${name}\nExec=${exec.map(quoteExecArg).join(' ')}\nX-GNOME-Autostart-enabled=true\n`;
}
