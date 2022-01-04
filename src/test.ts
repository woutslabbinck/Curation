/***************************************
 * Title: tests.ts
 * Description: TODO
 * Author: Wout Slabbinck (wout.slabbinck@ugent.be)
 * Created on 15/12/2021
 *****************************************/
import {getSession, isLoggedin, login} from "@treecg/ldes-orchestrator/dist/src/Login";
import {CurationConfig, Curator} from "../index";
import {memberToString} from "./util/Conversion";

const credentials = {
  "refreshToken": "vpMxN5be1bJuO4cU9bpeaGT8J6VuOSgx",
  "clientId": "JAhsucWnAdMIdl2c5fDPMcm0kHp5iVfF",
  "clientSecret": "9QjgocuLAAWWK4lWHy9uxI89JBh2SxaT",
  "issuer": "https://broker.pod.inrupt.com/",
};


const rootIRI = 'https://tree.linkeddatafragments.org/announcements/';
const curatedIRI = 'http://localhost:3050/curated/';
const synchronizedIRI = 'https://tree.linkeddatafragments.org/datasets/synced/';
const config: CurationConfig = {
  ldesIRI: rootIRI,
  curatedIRI: curatedIRI,
  synchronizedIRI: synchronizedIRI
};

async function synchronise(curator: Curator) {
  await curator.synchronize();
}

async function extractMember(curator: Curator) {
  const url = 'https://tree.linkeddatafragments.org/announcements/1639573889285/6eda2dfd-13e2-4d75-8edb-312e17c6f00f';
  const member = await curator.extractMember(url);
  console.log(await memberToString(member.value, member.iri));
}

async function extractMembers(curator: Curator) {
  const members = await curator.getRecentMembers(100);
  console.log(`amount of members in syncedCollection: ${members.length}`);
  if (members.length) {
    console.log(members[0]);
    const member = await curator.extractMember(members[0].memberIRI);
    console.log(await memberToString(member.value, member.iri));
  }
}

async function acceptNewestMember(curator: Curator) {
  await curator.init();
  const members = await curator.getRecentMembers(1);
  const member = await curator.extractMember(members[0].memberIRI);

  await curator.accept(members[0].memberIRI, member.value, members[0].timestamp);
}

async function rejectNewestMember(curator: Curator) {
  const members = await curator.getRecentMembers(1);
  await curator.reject(members[0].memberIRI, members[0].timestamp);
}

async function run() {
  // const session = new Session();
  // session.onNewRefreshToken((newToken: string): void => {
  //   console.log("New refresh token: ", newToken);
  // });
  // await session.login({
  //   clientId: credentials.clientId,
  //   clientSecret: credentials.clientSecret,
  //   refreshToken: credentials.refreshToken,
  //   oidcIssuer: credentials.issuer,
  // });
  login();
  await isLoggedin();
  const session =await getSession();
  const curator = new Curator(config, session);
  console.log(new Date());
  await curator.init(false);
  // await synchronise(curator);
  // console.log('syncing done');
  // await extractMember(curator);
  // await extractMembers(curator);
  // await acceptNewestMember(curator); // TODO tests again?
  // await rejectNewestMember(curator);
  // process.exit();

  // const store = await fetchResourceAsStore('https://tree.linkeddatafragments.org/announcements/', session);
  // console.log(storeToString(store));
}

run();
