/**
 * `@bankr/launch-sdk/server`: the entry for a builder's backend. The helpers that hold a launchpad signer's key
 * belong here, never in the root entry that browsers bundle. It re-exports the root API so an error thrown through
 * either entry is the same class.
 */
export * from "./index.js";
export {
  createAuthorizeHandler,
  padAuthorizer,
  signLaunchAuthorization,
  type AuthorizeHandlerOptions,
  type PadAuthorizerOptions,
  type PadSigner,
  type SignLaunchAuthorizationInput,
} from "./padSigner.js";
