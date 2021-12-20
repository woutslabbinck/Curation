import { rmdirSync} from 'fs';
import * as Path from 'path';

module.exports = async (): Promise<void> => {
  // remove solid pod (note, maybe do properly)
  rmdirSync(Path.join(__dirname, 'solidPod'), {recursive: true});
  process.exit();
};
