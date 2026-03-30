export declare class CreateNotificationConnectionDto {
    name: string;
    type: string;
    settings?: Record<string, unknown>;
    events?: string[];
    enabled?: boolean;
}
