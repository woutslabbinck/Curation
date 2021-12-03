/***************************************
 * Title: index
 * Description: TODO
 * Author: Wout Slabbinck (wout.slabbinck@ugent.be)
 * Created on 03/12/2021
 *****************************************/
import {Session} from "@inrupt/solid-client-authn-node";
import {Curator} from "./Curator";
const credentials ={
  "refreshToken": "dk2dttiWADhSJJ5m9aLryKLnUwzAqAYq",
  "clientId": "QavV4K693DmBtZrhzzQ4yjYLilgEzaso",
  "clientSecret": "WstewIdnkHTaqDo7yfwJZZHEnuLP17Mm",
  "issuer": "https://broker.pod.inrupt.com/",
};

async function execute(){
  const rootIRI = 'https://tree.linkeddatafragments.org/announcements/';
  const curatedIRI = 'https://tree.linkeddatafragments.org/datasets/curated/';
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
  const curator = new Curator(rootIRI,session, curatedIRI);

  // todo most recent announcements have to come from synced LDES
  const test = await curator.mostRecentAnnouncements(10);

  await curator.accept(test[0]);
  // todo create a reject
  process.exit();
}
execute();
