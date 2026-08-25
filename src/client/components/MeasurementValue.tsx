import { formatMeasurement, type Measurement, NOT_EXPOSED } from "../../shared/measurement";

/**
 * H15: the single component that renders a measurement.
 *
 * Routing every figure through here is what stops an unobservable value from
 * reaching the screen as a zero. The reason is carried in the title attribute,
 * so a technical viewer can ask why and get an answer.
 */
export function MeasurementValue<T>({
  measurement,
  format,
  unit,
}: {
  measurement: Measurement<T>;
  format?: (value: T) => string;
  unit?: string;
}) {
  if (!measurement.exposed) {
    return (
      <span className="measurement measurement--not-exposed" title={measurement.reason}>
        {NOT_EXPOSED}
      </span>
    );
  }
  return (
    <span className="measurement">
      {formatMeasurement(measurement, format)}
      {unit ? <small>{unit}</small> : null}
    </span>
  );
}

export function MeasurementRow<T>({
  label,
  measurement,
  format,
  unit,
}: {
  label: string;
  measurement: Measurement<T>;
  format?: (value: T) => string;
  unit?: string;
}) {
  return (
    <div className="measurement-row">
      <dt>{label}</dt>
      <dd>
        <MeasurementValue
          measurement={measurement}
          {...(format ? { format } : {})}
          {...(unit ? { unit } : {})}
        />
      </dd>
    </div>
  );
}
