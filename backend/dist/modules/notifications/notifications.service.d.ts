import { Repository } from 'typeorm';
import { NotificationConnection, NotificationEvent } from './entities/notification-connection.entity';
import { CreateNotificationConnectionDto } from './dto/create-notification-connection.dto';
export declare class NotificationsService {
    private readonly repo;
    private readonly log;
    constructor(repo: Repository<NotificationConnection>);
    create(dto: CreateNotificationConnectionDto): Promise<NotificationConnection>;
    findAll(): Promise<NotificationConnection[]>;
    findOne(id: number): Promise<NotificationConnection>;
    update(id: number, dto: CreateNotificationConnectionDto): Promise<NotificationConnection>;
    remove(id: number): Promise<void>;
    dispatch(event: NotificationEvent, payload: Record<string, unknown>): Promise<void>;
    testConnection(id: number): Promise<{
        ok: boolean;
        message: string;
    }>;
    private send;
    private formatMessage;
}
