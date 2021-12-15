/***************************************
 * Title: index
 * Description: TODO
 * Author: Wout Slabbinck (wout.slabbinck@ugent.be)
 * Created on 03/12/2021
 *****************************************/
import {Session} from "@inrupt/solid-client-authn-node";
import {CurationConfig, Curator} from "./Curator";
import { memberToString} from "./util/Conversion";

const credentials = {
  "refreshToken": "UbBUxyS96o7Fi43HJezMAcctRRtOPnv7",
  "clientId": "RzZGgFCDmxosLRhm3P0g2VwewjKGMR2s",
  "clientSecret": "uXuXg1yEpJmOB7uCURGahcI4jUM9jk1J",
  "issuer": "https://broker.pod.inrupt.com/",
};


const rootIRI = 'https://tree.linkeddatafragments.org/announcements/';
const curatedIRI = 'https://tree.linkeddatafragments.org/datasets/curated/';
const synchronizedIRI = 'https://tree.linkeddatafragments.org/datasets/synced/';
const config: CurationConfig = {
  ldesIRI: rootIRI,
  curatedIRI: curatedIRI,
  synchronizedIRI: synchronizedIRI
};

async function synchronise(curator:Curator) {
  await curator.synchronize();
}

async function extractMember(curator:Curator) {
  const url = 'https://tree.linkeddatafragments.org/announcements/1636985640000/ExampleDatasetAnnouncement.ttl';
  const member = await curator.extractMember(url);
  console.log(await memberToString(member.value, member.iri));
}
async function extractMembers(curator:Curator) {
  const members = await curator.getRecentMembers(100);
  console.log(`amount of members in syncedCollection: ${members.length}`);
  if (members.length) {
    console.log(members[0]);
  }
}
async function acceptNewestMember(curator:Curator) {
  await curator.init();
  const members = await curator.getRecentMembers(1);
  const member = await curator.extractMember(members[0].memberIRI);

  await curator.accept(member.value, members[0].memberIRI, members[0].timestamp );
}

async function rejectNewestMember(curator:Curator) {
  const members = await curator.getRecentMembers(1);
  await curator.reject(members[0].memberIRI, members[0].timestamp );
}
async function run(){
  const session = new Session();
  session.onNewRefreshToken((newToken: string): void => {
    console.log("New refresh token: ", newToken);
  });
  await session.login({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    refreshToken: credentials.refreshToken,
    oidcIssuer: credentials.issuer,
  });
  const curator = new Curator(config, session);
  console.log(new Date());
  // await curator.init();
  // await synchronise(curator);
  // await extractMember(curator);
  // await extractMembers(curator);
  await acceptNewestMember(curator);
  // await rejectNewestMember(curator);
  process.exit();
}

run();
