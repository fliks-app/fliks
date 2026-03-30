import { NotificationsService } from './notifications.service';
import { CreateNotificationConnectionDto } from './dto/create-notification-connection.dto';
export declare class NotificationsController {
    private readonly service;
    constructor(service: NotificationsService);
    create(dto: CreateNotificationConnectionDto): Promise<import("./entities/notification-connection.entity").NotificationConnection>;
    findAll(): Promise<import("./entities/notification-connection.entity").NotificationConnection[]>;
    findOne(id: number): Promise<import("./entities/notification-connection.entity").NotificationConnection>;
    update(id: number, dto: CreateNotificationConnectionDto): Promise<import("./entities/notification-connection.entity").NotificationConnection>;
    remove(id: number): Promise<void>;
    test(id: number): Promise<{
        ok: boolean;
        message: string;
    }>;
}
