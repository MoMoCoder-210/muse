type FieldDef = {
  key: string;
  label: string;
  type: "text" | "password" | "number";
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
};

type FieldGroup = {
  title: string;
  description?: string;
  fields: FieldDef[];
};

type ModelConfigSectionProps<T extends object> = {
  title: string;
  description: string;
  groups: FieldGroup[];
  values: T;
  onChange: (next: T) => void;
};

export function ModelConfigSection<T extends object>({
  title,
  description,
  groups,
  values,
  onChange,
}: ModelConfigSectionProps<T>) {
  function handleChange(key: string, raw: string, type: FieldDef["type"]) {
    const value = type === "number" ? Number(raw) : raw;
    onChange({ ...(values as Record<string, string | number>), [key]: value } as T);
  }

  const typedValues = values as Record<string, string | number>;

  return (
    <div className="model-config-section">
      <div className="model-config-header panel-header">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>

      <div className="model-config-groups">
        {groups.map((group) => (
          <section key={group.title} className="model-config-group">
            <div className="panel-header model-config-group-header">
              <h3>{group.title}</h3>
              {group.description ? <p>{group.description}</p> : null}
            </div>

            <div className="model-config-fields">
              {group.fields.map((field) => (
                <label key={field.key} className="field">
                  <span>{field.label}</span>
                  <input
                    type={field.type}
                    value={String(typedValues[field.key] ?? "")}
                    onChange={(e) => handleChange(field.key, e.target.value, field.type)}
                    placeholder={field.placeholder}
                    min={field.min}
                    max={field.max}
                    step={field.step}
                  />
                </label>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
