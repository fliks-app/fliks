import { Injectable } from '@angular/core';

const STORAGE_KEY = 'fliks-device-id';

@Injectable({ providedIn: 'root' })
export class DeviceIdService {
  readonly deviceId: string;

  constructor() {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(STORAGE_KEY, id);
    }
    this.deviceId = id;
  }
}
