import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';
export declare class UsersController {
    private readonly usersService;
    constructor(usersService: UsersService);
    findAll(): Promise<User[]>;
    findOne(id: number): Promise<User>;
    update(id: number, dto: UpdateUserDto, requester: User): Promise<User>;
    remove(id: number): Promise<void>;
    regenerateApiKey(id: number, requester: User): Promise<User>;
}
