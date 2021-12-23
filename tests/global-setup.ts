import {isLoggedin, login} from "@treecg/ldes-orchestrator/dist/src/Login";
import {isRunning, runSolid} from "./solidHelper";


async function start(): Promise<void> {
  // start server and wait till it is running + login and wait till that has succeeded
  login();
  runSolid();
  await isRunning();
  await isLoggedin();

}


module.exports = async (): Promise<void> => {
  try {
    await start();
  } catch (e) {
    console.log('Setting up test environment has failed.');
    console.log(e);
  }
};
