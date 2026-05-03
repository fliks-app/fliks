import { Observable } from 'rxjs';

export type ParamsType = { 
  hideLoader?: boolean
}

export interface IApiBaseActions {

  Get(endpoint: string, request?: ApiRequestOptions): Observable<any>;

  Post(endpoint: string, request?: ApiRequestOptions): Observable<any>;

  Delete(endpoint: string, request?: ApiRequestOptions): Observable<any>;

  Put(endpoint: string, request?: ApiRequestOptions): Observable<any>;

}

export interface ApiRequestOptions {
    params?: any;
    body?: any;
    options?: any;
    version?: number;
    headers?: any;
}