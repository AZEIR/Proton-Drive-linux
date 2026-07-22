declare module 'proton-drive-sdk-account' {
  export interface ApiClient {
    baseUrlWithProtocol: string;
    authenticatedRequest: import('ky').KyInstance;
  }
  export const ApiClient: new (...args: any[]) => ApiClient;
  export const initAccount: any;
  export type Auth = any;
  export const Auth: any;
  export type Srp = any;
  export const Srp: any;
  export type AccountApiError = any;
  export const AccountApiError: any;
  export type Addresses = any;
  export type SessionCredentials = any;
  export type SessionInfo = any;
}
