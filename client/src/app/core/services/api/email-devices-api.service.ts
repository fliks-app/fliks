import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export type EmailDeviceKind = 'kindle' | 'pocketbook' | 'other';

export interface EmailDevice {
  id: number;
  name: string;
  kind: EmailDeviceKind;
  address: string;
  formats: string[];
  createdAt: string;
}

export interface EmailDevices {
  /** False until the admin has set an SMTP host and sender. */
  enabled: boolean;
  /** False when the user's role lacks `books.email`. */
  canSend: boolean;
  maxBytes: number | null;
  devices: EmailDevice[];
}

export type BookSendStatus = 'queued' | 'sending' | 'sent' | 'failed';

export interface BookSend {
  id: number;
  deviceName: string;
  fileName: string;
  bytes: number;
  status: BookSendStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type EmailDeviceBody = Pick<EmailDevice, 'name' | 'kind' | 'address'> & { formats?: string[] };

/** E-mail addresses of e-readers and the mailing of a book file to them. */
@Injectable({ providedIn: 'root' })
export class EmailDevicesApiService {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<EmailDevices>('/api/email-devices'));
  }

  create(body: EmailDeviceBody) {
    return firstValueFrom(this.http.post<EmailDevice>('/api/email-devices', body));
  }

  update(id: number, body: EmailDeviceBody) {
    return firstValueFrom(this.http.put<EmailDevice>(`/api/email-devices/${id}`, body));
  }

  remove(id: number) {
    return firstValueFrom(this.http.delete<void>(`/api/email-devices/${id}`));
  }

  send(deviceId: number, fileId: number) {
    return firstValueFrom(this.http.post<BookSend>(`/api/email-devices/${deviceId}/send`, { fileId }));
  }

  sends() {
    return firstValueFrom(this.http.get<BookSend[]>('/api/book-sends'));
  }

  test(to: string) {
    return firstValueFrom(this.http.post<{ ok: boolean; message: string }>('/api/email/test', { to }));
  }
}
