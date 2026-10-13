import { AtprotoProvider } from "./atproto.ts";
import { DELVE } from "./atproto-post.ts";

export class DelveProvider extends AtprotoProvider {
  constructor(service = DELVE.service, fetcher: typeof fetch = fetch) {
    super(service, fetcher, DELVE);
  }
}
