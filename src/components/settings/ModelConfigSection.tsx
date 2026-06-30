/**
 * 单个模型的配置区块，复用于文本、生图、语音三个 tab。
 */

type FieldDef = {
  key: string;
  label: string;
  type: "text" | "password" | "number";
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
};

type ModelConfigSectionProps<T extends Record<string, unknown>> = {
  title: string;
  description: string;
  fields: FieldDef[];
  values: T;
  onChange: (next: T) => void;
};

export function ModelConfigSection<T extends Record<string, unknown>>({
  title,
  description,
  fields,
  values,
  onChange,
}: ModelConfigSectionProps<T>) {
  function handleChange(key: string, raw: string, type: FieldDef["type"]) {
    const value = type === "number" ? Number(raw) : raw;
    onChange({ ...values, [key]: value });
  }

  return (
    <div className="model-config-section">
      <div className="model-config-header">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <div className="model-config-fields">
        {fields.map((field) => (
          <label key={field.key} className="field">
            <span>{field.label}</span>
            <input
              type={field.type}
              value={String(values[field.key] ?? "")}
              onChange={(e) => handleChange(field.key, e.target.value, field.type)}
              placeholder={field.placeholder}
              min={field.min}
              max={field.max}
              step={field.step}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
