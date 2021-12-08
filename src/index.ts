/***************************************
 * Title: index
 * Description: TODO
 * Author: Wout Slabbinck (wout.slabbinck@ugent.be)
 * Created on 03/12/2021
 *****************************************/
import {Session} from "@inrupt/solid-client-authn-node";
import {CurationConfig, Curator} from "./Curator";

const credentials = {
  "refreshToken": "dRvFxa6Dn4O22zN6IzlmtDIZt28WVsKZ",
  "clientId": "qY343r217fwQOStZTQxQvBOZ96yuwoUN",
  "clientSecret": "VHHK7uSon3CeTZITYRI7bOHeMbLpIUP3",
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
async function execute() {
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

  // todo most recent announcements have to come from synced LDES
  const test = await curator.mostRecentAnnouncements(10);

  // todo: create a shape for curation and place it in curation (targetClass view, dataset and body
  await curator.accept(test[0]);
  // todo create a reject
  process.exit();
}

// execute();

async function synchronise() {
  const session = new Session();
  const curator = new Curator(config, session);
  curator.synchronize();
}

synchronise();
