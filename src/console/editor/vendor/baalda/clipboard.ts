/**
 * Clipboard write that survives an `await` before it.
 *
 * PORTING NOTE (see ../PORTING.md): upstream tried a Tauri clipboard plugin
 * first. This console is a plain browser app, so the Tauri import is dropped;
 * the web Clipboard API and the hidden-textarea `execCommand("copy")` fallback
 * are kept. Returns whether ANY path succeeded; callers decide what to show.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* fall through to execCommand */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Off-screen but focusable; `readonly` stops the iOS-style keyboard flash.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
