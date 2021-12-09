/***************************************
 * Title: Curator
 * Description: TODO
 * Author: Wout Slabbinck (wout.slabbinck@ugent.be)
 * Created on 03/12/2021
 *****************************************/
import {Session} from "@inrupt/solid-client-authn-node";
import {EventStream, LDESClient, newEngine} from '@treecg/actor-init-ldes-client';
import {extractAnnouncementsMetadata, fetchAllAnnouncements} from "@treecg/ldes-announcements";
import {Announce} from "@treecg/ldes-announcements/dist/util/Interfaces";
import {Collection, Node, Relation, URI} from "@treecg/tree-metadata-extraction/dist/util/Util";
import {DataFactory, Store, Writer} from "n3";
import {Logger} from "./logging/Logger";
import {LDP, RDF, TREE} from "./util/Vocabularies";
import namedNode = DataFactory.namedNode;


const parse = require('parse-link-header');

export interface CurationConfig {
    ldesIRI: string,
    curatedIRI: string,
    synchronizedIRI: string
}

export class Curator {

  private readonly logger = new Logger(this);
  // root of LDES
  private ldesIRI: string;
  private session: Session;
  private curatedIRI: string;
  private synchronizedIRI: string;

  constructor(config: CurationConfig, session: Session) {
    this.curatedIRI = config.curatedIRI;
    this.ldesIRI = config.ldesIRI;
    this.synchronizedIRI = config.synchronizedIRI;
    this.session = session;
  }

  public async mostRecentAnnouncements(amount: number): Promise<Announce []> {
    this.logger.info("start fetching and extracting announcements");
    // currently very inefficient -> should only extract announcement when asked
    const announcementsStore = await fetchAllAnnouncements(this.ldesIRI);
    const extracted = await extractAnnouncementsMetadata(announcementsStore);
    this.logger.info("announcements are extracted");

    const announcements: Announce[] = [];
    extracted.announcements.forEach(value => {
      const announcement = {...value};
      // TODO: I still have to extract datasets and dataservices
      announcement.object = extracted.views.get(<string>value.object['@id'])!;
      announcements.push(announcement);
    });
    this.logger.info("announcements have view now");
    announcements.sort((first, second) => {
      if (first.object && second.object && 'dct:issued' in first.object && 'dct:issued' in second.object) {
        const firstTimestamp = new Date(first.object["dct:issued"]!["@value"]).getTime();
        const secondTimestamp = new Date(second.object["dct:issued"]!["@value"]).getTime();
        return secondTimestamp - firstTimestamp;
      }
      return 1;
    });
    return announcements.slice(0, amount);
  }

  public async accept(announcement: Announce) {
    // assume that object is already valid and not the id
    const response = await this.session.fetch(this.curatedIRI, {
      method: 'HEAD'
    });


    const linkHeaders = parse(response.headers.get('link'));
    if (!linkHeaders) {
      throw new Error('No Link Header present.');
    }
    const inboxLink = linkHeaders[LDP.inbox];
    if (!inboxLink) {
      throw new Error('No http://www.w3.org/ns/ldp#inbox Link Header present.');
    }

    // Location is the current inbox which can be written to
    const location = `${inboxLink.url}`;

    this.logger.info(`posting announcement to location: ${location}`);

    const postResponse = await this.session.fetch(location, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ld+json',
        Link: '<http://www.w3.org/ns/ldp#Resource>; rel="type"'
      },
      body: JSON.stringify(announcement.object)
    });
    if (postResponse.status !== 201) {
      this.logger.error(await postResponse.text());
      throw Error('Not succesfull');
    }
    this.logger.info(`Object from announcement located at: ${postResponse.url}`);

  }

  public async synchronize() {
    const LDESRootNode = `${this.ldesIRI}root.ttl`;
    const LDESRootCollectionIRI = `${LDESRootNode}#Collection`;
    const syncedRootNode = `${this.synchronizedIRI}root.ttl`;
    const options = {
      "pollingInterval": 5000, // millis
      "representation": "Quads", //Object or Quads
      "emitMemberOnce": true,
      "disableSynchronization": true
    };
    const LDESClient: LDESClient = newEngine();
    const eventstreamSync: EventStream = LDESClient.createReadStream(LDESRootNode, options);


    let LDESCollection: string;
    eventstreamSync.on('data', (member) => {
      console.log(member);
    });
    eventstreamSync.on('metadata', ({treeMetadata, url}) => {
      // console.log(treeMetadata);
      // is it a root?
      if (url === LDESRootNode) {
        // First time
        // create new root body
        const collection: Collection = {
          "@context": {"@vocab": TREE.namespace},
          "@id": `${syncedRootNode}#Collection`,
          "@type": [TREE.Collection],
          view: [{"@id": syncedRootNode}]
        };
        const view: Node = {
          "@context": {"@vocab": TREE.namespace},
          "@id": syncedRootNode,
          "@type": [TREE.Node],
          relation: []
        };
        const relations: Relation[] = [];
        treeMetadata.nodes.get(url).relation.forEach((relationIRI: URI) => {
          // clone the relation -> I don't want to update it
          const relation: Relation = {...treeMetadata.relations.get(relationIRI['@id'])};
          // In practice this if holds always
          if (relation.node && relation.node[0]) {
            // change relation of node -> again clone it otherwise the original node is changed
            relation.node = {...relation.node};
            relation.node[0] = {"@id": relation.node[0]['@id'].replace(this.ldesIRI, this.synchronizedIRI)};
          }
          view.relation?.push(relationIRI); // i just defined it, believe me it's there
          relations.push(relation);
        });
        const body = [collection, view, ...relations];
        this.session.fetch(syncedRootNode, {
          method: "PUT",
          headers: {
            "Content-Type": "application/ld+json",
            "Link": `<http://www.w3.org/ns/ldp#Resource>; rel="type"`
          },
          body: JSON.stringify(body)
        }).then(async (response: Response) => {
          this.logger.info(`Try to send root to ${this.synchronizedIRI} | status: ${response.status}`);
          this.logger.debug(await response.text());
        });
      } else {
        // get all member URIs and add them as member to collection, then post them to {syncedURI}/timestamp
        fetch(url).then(async response => {
          const text = await response.text();
          const rdfParser = require("rdf-parse").default;
          const streamifyString = require('streamify-string');
          const storeStream = require("rdf-store-stream").storeStream;

          const textStream = streamifyString(text);
          const quadStream = rdfParser.parse(textStream, {contentType: 'text/turtle'});
          const store = await storeStream(quadStream);
          const members = store.getObjects(null, 'http://www.w3.org/ns/ldp#contains', null, null)
            .map((object: any) => namedNode(url + object.id)); // needed because CSS only gives last part of iri

          const collection = new Store();
          collection.addQuad(namedNode(LDESRootCollectionIRI), namedNode(RDF.type), namedNode(TREE.Collection));
          members.forEach((member: any) => {
            collection.addQuad(namedNode(LDESRootCollectionIRI), namedNode(TREE.member), member);
          });
          const writer = new Writer();
          const body = writer.quadsToString(collection.getQuads(null, null, null, null));
          const collectionIRI = url.replace(this.ldesIRI,this.synchronizedIRI);
          this.session.fetch(collectionIRI, {
            method: "PUT",
            headers: {
              "Content-Type": "text/turtle",
              "Link": `<http://www.w3.org/ns/ldp#Resource>; rel="type"`
            },
            body: JSON.stringify(body)
          }).then(async (response: Response) => {
            this.logger.info(`Try to send part of the collection to ${collectionIRI} | status: ${response.status}`);
            this.logger.debug(await response.text());
          });

        });
      }
      // else
      //     {
      //         // get highest value
      //         let largest = {timestamp: 0, url: ''};
      //         treeMetadata['relations'].forEach((element: { value: { [x: string]: any; }[]; node: { [x: string]: any; }[]; }) => {
      //             const datetime = element.value[0]['@value'];
      //             const timestamp = new Date(datetime).getTime();
      //
      //             if (timestamp > largest.timestamp) {
      //                 largest = {
      //                     url: element.node[0]['@id'],
      //                     timestamp: new Date(timestamp).getTime()
      //                 };
      //             }
      //         });
      //     }
    });
    eventstreamSync.on('end', () => {
      this.logger.info("LDESClient finds no more data");
    });
  }


}
