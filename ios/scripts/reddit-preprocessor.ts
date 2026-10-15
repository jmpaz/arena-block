import { readSubstackPage } from "../../packages/core/substack-page.ts";
(globalThis as any).ExtensionPreprocessingJS = {
  run(arguments_: { completionFunction(value: Record<string, string>): void }) {
    if (location.hostname === "substack.com" && /\/note\/c-\d+/.test(location.pathname)) {
      void readSubstackPage().then(value => arguments_.completionFunction({ substackCapture: JSON.stringify(value) }),
        error => arguments_.completionFunction({ substackError: error instanceof Error ? error.message : String(error) }));
      return;
    }
    // Ordinary shares pass the source URL. Reddit acquisition belongs to the
    // same direct provider used by CLI and native URL paste, outside Safari.
    arguments_.completionFunction({ sourceUrl: location.href });
  },
};
