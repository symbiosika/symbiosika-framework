import { stringify } from "csv-stringify";

interface CsvOptions {
  separator?: string;
  useQuotes?: boolean;
  header?: boolean;
  columns?: string[];
}

export class CsvService {
  private defaultOptions: CsvOptions = {
    separator: ",",
    useQuotes: true,
    header: true,
  };

  async objectsToCsv(
    data: Record<string, any>[],
    options: CsvOptions = {}
  ): Promise<string> {
    const mergedOptions = { ...this.defaultOptions, ...options };
    const {
      separator,
      useQuotes,
      header,
      columns = Object.keys(data[0] || {}),
    } = mergedOptions;

    return new Promise((resolve, reject) => {
      stringify(
        data,
        {
          delimiter: separator,
          quoted: useQuotes,
          header: header,
          columns: columns,
        },
        (err, output) => {
          if (err) {
            reject(err);
          } else {
            resolve(output);
          }
        }
      );
    });
  }
}
