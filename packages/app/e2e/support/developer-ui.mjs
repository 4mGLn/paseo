/** @param {import('@playwright/test').Page} page */
export async function installDeveloperToastDismissal(page) {
  // Keep developer chrome out of app actions without pointer/focus changes.
  // Locator handlers can deadlock when concurrent checks dismiss the same toast.
  const install = () => {
    let observedRoot;
    const options = { childList: true, subtree: true };
    const dismiss = () => {
      const toast = document.getElementById("error-toast");
      const root = toast?.shadowRoot ?? toast;
      if (root && root !== observedRoot) {
        observer.disconnect();
        observer.observe(document, options);
        observer.observe(root, options);
        observedRoot = root;
      }
      // Expo's toast root contains dismiss buttons; its overlay has a different ID.
      for (const button of root?.querySelectorAll("button") ?? [])
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    };
    const observer = new MutationObserver(dismiss);
    observer.observe(document, options);
    dismiss();
  };
  await page.addInitScript(install);
  await page.evaluate(install);
}
