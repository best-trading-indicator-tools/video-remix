import { PUBLISHING_LANGUAGES } from '../shared/publishing-language';

export default function PostLanguageSelect({ value, onChange, disabled = false, label = 'Content language' }: {
  value: string; onChange: (language: string) => void; disabled?: boolean; label?: string;
}) {
  return <label>{label}<select value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
    {PUBLISHING_LANGUAGES.map(language => <option key={language} value={language}>{language}{language === 'English' ? ' (default)' : ''}</option>)}
    {!PUBLISHING_LANGUAGES.includes(value) && <option value={value}>{value}</option>}
  </select></label>;
}
