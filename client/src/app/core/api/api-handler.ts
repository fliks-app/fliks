import { Injectable } from '@angular/core';
import { ApiRequestOptions, IApiBaseActions, ParamsType } from './api-base-action';
import { HttpClient, HttpEvent, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

@Injectable({
    providedIn: 'root'
})
export class ApiHandlerService implements IApiBaseActions {


    constructor(
        public httpClient: HttpClient,
    ) { }

    getBaseUrl(version: number = 1) {
        return `${environment.apiUrl}/v${version}/`;
    }

    Get<T>(endpoint: string, request?: ApiRequestOptions): Observable<HttpEvent<T>> {
        return this.httpClient
            .get<T>(`${this.getBaseUrl(request?.version)}` + endpoint, { 
                params: this.createParams(request?.params), 
                withCredentials: true,
                ...request?.options 
            })
    }

    Post<T>(endpoint: string, request?: ApiRequestOptions): Observable<HttpEvent<T>> {
        return this.httpClient
            .post<T>(`${this.getBaseUrl(request?.version)}` + endpoint, request?.body, { 
                params: this.createParams(request?.params), 
                withCredentials: true,
                ...request?.options 
            })
    }

    Put<T>(endpoint: string, request?: ApiRequestOptions): Observable<HttpEvent<T>> {
        return this.httpClient
            .put<T>(`${this.getBaseUrl(request?.version)}` + endpoint, request?.body, { 
                params: this.createParams(request?.params), 
                withCredentials: true,
                ...request?.options 
            })
    }

    Patch<T>(endpoint: string, request?: ApiRequestOptions): Observable<HttpEvent<T>> {
        return this.httpClient
            .patch<T>(`${this.getBaseUrl(request?.version)}` + endpoint, request?.body, { 
                params: this.createParams(request?.params), 
                withCredentials: true,
                ...request?.options 
            })
    }

    Delete<T>(endpoint: string, request?: ApiRequestOptions): Observable<HttpEvent<T>> {
        return this.httpClient
            .delete<T>(`${this.getBaseUrl(request?.version)}` + endpoint, { 
                params: this.createParams(request?.params), 
                withCredentials: true,
                ...request?.options 
            })
    }

    createParams(params?: ParamsType) {
        let httpParams = new HttpParams();
        if (params) {
            Object.entries(params).forEach(([key, value]) => {
                httpParams = httpParams.append(key, value);
            });
        }
        return httpParams;
    }

}