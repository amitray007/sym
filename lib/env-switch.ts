// An on/off setting from the environment. `on`, `true`, `1`, and `yes` turn it on; `off`, `false`,
// `0`, and `no` turn it off (any case). Anything else, including unset, gives the fallback.
export function envSwitch(value: string | undefined, fallback: boolean): boolean {
  const word = (value ?? "").trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(word)) return true;
  if (["off", "false", "0", "no"].includes(word)) return false;
  return fallback;
}
