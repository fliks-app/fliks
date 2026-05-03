import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiHandlerService } from './api-handler';
import { ApiRequestOptions } from './api-base-action';

@Injectable({
    providedIn: 'root'
})
export class ApiService {

    constructor(private apiHandlerService: ApiHandlerService) { }

    get<T>(endpoint: string, request?: ApiRequestOptions): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            firstValueFrom(this.apiHandlerService.Get<T>(endpoint, request)).then((response) => {
                resolve(response as T)
            }).catch((error) => {
                reject(error)
            })
        })
    }

    post<T>(endpoint: string, request?: ApiRequestOptions): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            firstValueFrom(this.apiHandlerService.Post<T>(endpoint, request)).then((response) => {
                resolve(response as T)
            }).catch((error) => {
                reject(error)
            })
        })
    }

    put<T>(endpoint: string, request?: ApiRequestOptions): Promise<T> {
        return new Promise((resolve, reject) => {
            firstValueFrom( this.apiHandlerService.Put<T>(endpoint, request)).then((response) => {
                resolve(response as T)
            }).catch((error) => {
                reject(error)
            })
        })
    }

    patch<T>(endpoint: string, request?: ApiRequestOptions): Promise<T> {
        return new Promise((resolve, reject) => {
            firstValueFrom( this.apiHandlerService.Patch<T>(endpoint, request)).then((response) => {
                resolve(response as T)
            }).catch((error) => {
                reject(error)
            })
        })
    }

    delete<T>(endpoint: string, request?: ApiRequestOptions): Promise<T> {
        return new Promise((resolve, reject) => {
            firstValueFrom( this.apiHandlerService.Delete<T>(endpoint, request)).then((response) => {
                resolve(response as T)
            }).catch((error) => {
                reject(error)
            })
        })
    }

}