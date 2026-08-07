import { SetMetadata } from '@nestjs/common';
import { AppAbility } from './casl-ability.factory';

export interface IPolicyHandler {
  handle(ability: AppAbility): boolean;
}

type PolicyHandlerCallback = (ability: AppAbility) => boolean;
export type PolicyHandler = IPolicyHandler | PolicyHandlerCallback;

export const CHECK_POLICIES_KEY = 'check_policies';
export const CheckPolicies = (...handlers: PolicyHandler[]) =>
  SetMetadata(CHECK_POLICIES_KEY, handlers);

/** For handlers scoped to the caller's own record, where CASL has no object to test.
 *  `PoliciesGuard` denies handlers that declare nothing, so the intent must be explicit. */
export const AnyAuthenticatedUser: PolicyHandlerCallback = () => true;
