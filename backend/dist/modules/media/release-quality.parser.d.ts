import { SuitarrQualityDefinition } from '../../common/constants/suitarr-qualities';
export interface ParsedReleaseQuality {
    quality: SuitarrQualityDefinition;
    label: string;
}
export declare function parseReleaseQuality(title: string): ParsedReleaseQuality;
