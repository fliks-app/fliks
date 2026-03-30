import { RequestStatus } from '../../../common/enums';
export declare class ListRequestsDto {
    status?: RequestStatus;
    page?: number;
    limit?: number;
}
