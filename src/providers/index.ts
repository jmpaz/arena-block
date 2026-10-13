import { SocialResolver as PortableSocialResolver } from "../../packages/core/providers/index.ts";
import { SoundCloudProvider } from "./soundcloud.ts";

export * from "../../packages/core/providers/index.ts";
export { SoundCloudProvider } from "./soundcloud.ts";

export class SocialResolver extends PortableSocialResolver {
  constructor(providers: ConstructorParameters<typeof PortableSocialResolver>[0] = {}) {
    super({ ...providers, soundcloud: providers?.soundcloud ?? new SoundCloudProvider() });
  }
}
