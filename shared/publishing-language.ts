import { z } from 'zod';

export const DEFAULT_PUBLISHING_LANGUAGE = 'English';
export const PUBLISHING_LANGUAGES = ['English', 'French', 'Spanish', 'German', 'Italian', 'Portuguese', 'Portuguese (Brazil)',
  'Dutch', 'Polish', 'Arabic', 'Hindi', 'Japanese', 'Korean', 'Chinese (Simplified)', 'Chinese (Traditional)',
  'Indonesian', 'Russian', 'Turkish', 'Ukrainian', 'Vietnamese', 'Thai'];
export const languageNameSchema = z.string().trim().min(1).max(60).regex(/^[^\u0000-\u001f\u007f]*$/u);
export const publishingLanguageSchema = languageNameSchema.default(DEFAULT_PUBLISHING_LANGUAGE);
