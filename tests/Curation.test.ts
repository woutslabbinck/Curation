import {readdirSync, rmdirSync} from "fs";
import Path from "path";
import {Session} from "@inrupt/solid-client-authn-node";
import {createViewAnnouncement, postAnnouncement} from "@treecg/ldes-announcements";
import {AnnouncementConfig} from "@treecg/ldes-announcements/dist/lib/Writer";
import {Announce} from "@treecg/ldes-announcements/dist/util/Interfaces";
import {ACLConfig, getSession, LDESConfig, LDESinSolid, Orchestrator} from "@treecg/ldes-orchestrator";
import {Store} from "n3";
import {Curator} from "../src/Curator";
import {fileAsStore, turtleStringToStore} from "../src/util/Conversion";
import {DCT, RDF, TREE} from "../src/util/Vocabularies";
import {solidUrl, sleep} from "./solidHelper";

describe('Integration test for LDESinSolid and Orchestrating functionalities', () => {
  const base: string = solidUrl();
  let session: Session;
  let announcement: Announce;
  const solidPodPath = Path.join(__dirname, 'solidPod');

  beforeAll(async () => {
    // create session
    session = await getSession();

    // create announcement
    const viewString = '<https://test/output/root.ttl> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/tree#Node>.';
    const viewStore = await turtleStringToStore(viewString);
    const announcementConfig: AnnouncementConfig = {
      bucketizer: 'substring',
      creatorName: 'woutslabbinck',
      creatorURL: `https://github.com/woutslabbinck`,
      originalLDESURL: 'https://smartdata.dev-vlaanderen.be/base/gemeente',
      pageSize: '100',
      propertyPath: '<http://www.w3.org/2000/01/rdf-schema#label>',
      viewId: 'https://test/output/root.ttl'
    };
    announcement = await createViewAnnouncement(viewStore, announcementConfig);

  });
  describe('General tests', () => {
    it('server online', async () => {
      const getRequest = await fetch(base);
      expect(getRequest.status).toBe(200);
    });

    it('is logged in', async () => {
      expect(session.info.isLoggedIn).toBe(true);
    });
  });
  describe('Curation', () => {
    const curationDirectory = 'curationTest';
    const ldesName = 'ldes';
    const curatedName = 'curated';
    const synchronizedName = 'synchronized';

    const curationbaseUrl = `${base + curationDirectory}/`;

    const ldesBaseUrl = `${curationbaseUrl + ldesName}/`;
    const curatedIRI = `${curationbaseUrl + curatedName}/`;
    const synchronizedIRI = `${curationbaseUrl + synchronizedName}/`;
    const curationConfig = {
      ldesIRI: ldesBaseUrl,
      curatedIRI: curatedIRI,
      synchronizedIRI: synchronizedIRI
    };

    // path to the synchronized directory
    const synchronizedPath = Path.join(solidPodPath, curationDirectory, synchronizedName);


    /**
         * Very specific function to get the relation store of a synced collection node
         * @returns {Promise<Store<Quad, Quad, Quad, Quad>>}
         */
    async function getSyncedRelationStore(): Promise<Store> {
      const rootStore = await fileAsStore(Path.join(synchronizedPath, 'root.ttl'));
      const relationUrl = rootStore.getQuads(null, TREE.node, null, null)[0].object.id;
      const relationName = relationUrl.split('/').slice(-1)[0];
      return await fileAsStore(Path.join(synchronizedPath, `${relationName}$.ttl`));
    }

    beforeEach(async () => {
      const ldesConfig: LDESConfig = {
        base: ldesBaseUrl,
        treePath: DCT.modified,
        shape: 'https://tree.linkeddatafragments.org/announcements/shape',
        relationType: TREE.GreaterThanOrEqualToRelation
      };
      if (!session.info.webId) throw Error("Should be present");
      const aclConfig: ACLConfig = {
        agent: session.info.webId
      };

      const ldes = new LDESinSolid(ldesConfig, aclConfig, session, 1);
      await ldes.createLDESinLDP();
    });

    afterEach(async () => {
      rmdirSync(Path.join(solidPodPath, curationDirectory), {recursive: true});
    });

    it('Synchronizing', async () => {
      const response = await postAnnouncement(announcement, ldesBaseUrl) as Response;
      const announcementURI = response.headers.get('location');
      const curator = new Curator(curationConfig, session);
      await curator.synchronize();

      // read synchronize file and conform that URI of announcement
      const files = readdirSync(synchronizedPath);
      expect(files.includes('root.ttl')).toBe(true);
      expect(files.length).toBe(2);

      const relationStore = await getSyncedRelationStore();

      // time object of the announcement should exist
      expect(relationStore.getQuads(announcementURI, null, null, null).length).toBe(1);

    });

    it('Multiple synchronizing: Orchestrator was executed', async () => {
      // initialise ldes, orchestrator and curator
      const ldesConfig = await LDESinSolid.getConfig(ldesBaseUrl, session);
      const ldes = new LDESinSolid(ldesConfig.ldesConfig, ldesConfig.aclConfig, session, 1);
      const orchestrator = new Orchestrator(session);
      const curator = new Curator(curationConfig, session);

      // add one announcement
      await postAnnouncement(announcement, ldesBaseUrl);

      // synchronize once
      await curator.synchronize();

      // orchestrate once
      orchestrator.orchestrateLDES(ldes, .1);
      await sleep(1000); // make sure there was some orchestration
      orchestrator.stopOrchestrating();

      // add another announcement
      await postAnnouncement(announcement, ldesBaseUrl);

      // synchronize again
      await curator.synchronize();

      const files = readdirSync(synchronizedPath);
      expect(files.length).toBe(3);

    });

    it('Multiple synchronizing: new member was added', async () => {
      const curator = new Curator(curationConfig, session);

      // add one announcement
      const responseAnnouncement1 = await postAnnouncement(announcement, ldesBaseUrl);

      // synchronize once
      await curator.synchronize();

      // add one announcement
      const responseAnnouncement2 = await postAnnouncement(announcement, ldesBaseUrl);

      await curator.synchronize();

      const relationStore = await getSyncedRelationStore();

      const announcementPresent1 = relationStore.getQuads(responseAnnouncement1.headers.get('location'), null, null, null);
      const announcementPresent2 = relationStore.getQuads(responseAnnouncement2.headers.get('location'), null, null, null);

      expect(announcementPresent1.length).toBe(1);
      expect(announcementPresent2.length).toBe(1);
    });

    it('Retrieve empty list when memberUris are not synchronized', async () => {
      const curator = new Curator(curationConfig, session);
      await postAnnouncement(announcement, ldesBaseUrl);
      const members = await curator.getRecentMembers(1);
      expect(members.length).toBe(0);
    });

    it('Retrieve list of memberUris of synchronized list', async () => {
      const curator = new Curator(curationConfig, session);
      const response = await postAnnouncement(announcement, ldesBaseUrl);
      await curator.synchronize();

      const members = await curator.getRecentMembers(1);
      expect(members.length).toBe(1);
      expect(members[0].memberIRI).toBe(response.headers.get('location'));
    });

    it('Extracting one member', async () => {
      const curator = new Curator(curationConfig, session);
      const response = await postAnnouncement(announcement, ldesBaseUrl);
      await curator.synchronize();
      const members = await curator.getRecentMembers(1);
      const member = await curator.extractMember(members[0].memberIRI);
      expect(member.type).toBe(TREE.Node);
      expect(member.value["@id"]).toBe(`${response.headers.get('location')}#view`);
    });

    it('Initiating the curated ldes', async () => {
      const curator = new Curator(curationConfig, session);
      await curator.init();

      const curatedLdesPath = Path.join(solidPodPath, curationDirectory, curatedName);
      const curatedFiles = readdirSync(curatedLdesPath);
      expect(curatedFiles.includes('root.ttl')).toBe(true);
      // files expected are: the root, the directory of the relation of the root, the acl file of the ldes and the .meta file
      expect(curatedFiles.length).toBe(4);

      const curatedRoot = await fileAsStore(Path.join(curatedLdesPath, 'root.ttl'));
      const view = curatedRoot.getQuads(`${curatedIRI}root.ttl`, RDF.type, null, null)[0];
      expect(view.object.id).toBe(TREE.Node);
    });

    it('Rejecting one member (giving the timestamp)', async () => {
      const curator = new Curator(curationConfig, session);
      await postAnnouncement(announcement, ldesBaseUrl);
      await curator.synchronize();
      const members = await curator.getRecentMembers(1);
      await curator.reject(members[0].memberIRI, members[0].timestamp);

      const membersLeft = await curator.getRecentMembers(1);
      expect(membersLeft.length).toBe(0);
    });

    it('Rejecting one member (not giving the timestamp)', async () => {
      const curator = new Curator(curationConfig, session);
      const response = await postAnnouncement(announcement, ldesBaseUrl);
      await curator.synchronize();

      await curator.reject(response.headers.get('location'));
      await curator.reject(response.headers.get('location'));

      const membersLeft = await curator.getRecentMembers(1);
      expect(membersLeft.length).toBe(0);
    });

    it('Accepting without initialising should throw error', async () => {
      expect.assertions(2);
      const curator = new Curator(curationConfig, session);
      try {
        await curator.accept('iri');
      } catch (e) {
        const err = e as Error;
        expect(err.name).toBe("Error");
        expect(err.message).toBe("First execute function init() as the curated LDES was not initialised yet");
      }
    });

    it('Accepting one member (giving all information)', async () => {
      const curator = new Curator(curationConfig, session);
      await postAnnouncement(announcement, ldesBaseUrl);
      await curator.synchronize();
      await curator.init();
      const members = await curator.getRecentMembers(1);
      const member = await curator.extractMember(members[0].memberIRI);

      await curator.accept(members[0].memberIRI, member.value, members[0].timestamp);
      // very ugly code to get the file where the member is added -> todo: Get it via a nice way
      const curatedLdesPath = Path.join(solidPodPath, curationDirectory, curatedName);
      const directoryInCuratedLdes = readdirSync(curatedLdesPath, {withFileTypes: true})
        .filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);
      const relationPath = Path.join(solidPodPath, curationDirectory, curatedName, directoryInCuratedLdes[0]);
      const curatedMemberFileName = readdirSync(relationPath).filter(name => !name.includes('acl'))[0];

      const curatedRoot = await fileAsStore(Path.join(relationPath, curatedMemberFileName));
      const view = curatedRoot.getQuads(`${member.iri}#view`, RDF.type, null, null)[0];
      expect(view.object.id).toBe(TREE.Node);
    });

    it('Accepting one member (giving only the memberIRI)', async () => {
      const curator = new Curator(curationConfig, session);
      const response = await postAnnouncement(announcement, ldesBaseUrl);
      await curator.synchronize();
      await curator.init();

      const memberIri = response.headers.get('location');
      await curator.accept(memberIri);
      // very ugly code to get the file where the member is added -> todo: Get it via a nice way

      const curatedLdesPath = Path.join(solidPodPath, curationDirectory, curatedName);
      const directoryInCuratedLdes = readdirSync(curatedLdesPath, {withFileTypes: true})
        .filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);
      const relationPath = Path.join(solidPodPath, curationDirectory, curatedName, directoryInCuratedLdes[0]);
      const curatedMemberFileName = readdirSync(relationPath).filter(name => !name.includes('acl'))[0];
      const curatedMemberPath = Path.join(relationPath, curatedMemberFileName);
      const curatedRoot = await fileAsStore(curatedMemberPath);
      const view = curatedRoot.getQuads(`${memberIri}#view`, RDF.type, null, null)[0];
      expect(view.object.id).toBe(TREE.Node);
    });
  });

});
