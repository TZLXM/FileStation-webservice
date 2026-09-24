import { SetMetadata } from '@nestjs/common';
import { ApiTokenScope } from '@filestation/shared';

export const REQUIRED_SCOPES_KEY = 'required_scopes';
export const RequireScopes = (...scopes: ApiTokenScope[]) => SetMetadata(REQUIRED_SCOPES_KEY, scopes);
