import { Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { UpdateUserDto } from './dto/update-user.dto';
export declare class UsersService {
    private readonly userRepo;
    constructor(userRepo: Repository<User>);
    findAll(): Promise<User[]>;
    findOne(id: number): Promise<User>;
    update(targetId: number, dto: UpdateUserDto, requester: User): Promise<User>;
    remove(id: number): Promise<void>;
    regenerateApiKey(id: number, requester: User): Promise<User>;
}
