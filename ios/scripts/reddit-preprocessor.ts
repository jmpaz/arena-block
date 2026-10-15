import { readSubstackPage } from "../../packages/core/substack-page.ts";
import { readRedditPage } from "../../packages/core/reddit-browser-reader.ts";
(globalThis as any).ExtensionPreprocessingJS = {
  run(arguments_: { completionFunction(value: Record<string, string>): void }) {
    if (location.hostname === "substack.com" && /\/note\/c-\d+/.test(location.pathname)) {
      void readSubstackPage().then(value => arguments_.completionFunction({ substackCapture: JSON.stringify(value) }),
        error => arguments_.completionFunction({ substackError: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (!["www.reddit.com", "reddit.com", "old.reddit.com", "new.reddit.com"].includes(location.hostname)) {
      arguments_.completionFunction({ sourceUrl: location.href }); return;
    }
    void readRedditPage().then(value => arguments_.completionFunction({ redditCapture: JSON.stringify(value) }),
      error => {
        const message = error instanceof Error ? error.message : String(error);
        // A denied page API is handed to the native public-browser adapter as an ordinary URL.
        // Never attest that this possibly signed-in Safari page was a credentialless DOM read.
        arguments_.completionFunction(/Reddit browser read returned HTTP 403 without usable JSON/.test(message)
          ? { redditSourceUrl: location.href } : { redditError: message });
      });
  },
};
