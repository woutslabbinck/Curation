/***************************************
 * Title: Curator
 * Description: TODO
 * Author: Wout Slabbinck (wout.slabbinck@ugent.be)
 * Created on 03/12/2021
 *****************************************/
import {Session} from "@inrupt/solid-client-authn-node";
import { EventStream, LDESClient, newEngine } from '@treecg/actor-init-ldes-client';
import {extractAnnouncementsMetadata, fetchAllAnnouncements} from "@treecg/ldes-announcements";
import {Announce} from "@treecg/ldes-announcements/dist/util/Interfaces";
import {Logger} from "./logging/Logger";
import {LDP} from "./util/Vocabularies";


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

  constructor(config : CurationConfig, session: Session) {
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

  public async accept(announcement:Announce){
    // assume that object is already valid and not the id
    const response = await this.session.fetch(this.curatedIRI,{
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
    if (postResponse.status !== 201){
      this.logger.error(await postResponse.text());
      throw Error('Not succesfull');
    }
    this.logger.info(`Object from announcement located at: ${postResponse.url}`);

  }

  public async synchronize(){
    const options = {
      "pollingInterval": 5000, // millis
      "representation": "Quads", //Object or Quads
      "emitMemberOnce": true,
      "disableSynchronization": true
    };
    const LDESClient: LDESClient =  newEngine();
    const eventstreamSync: EventStream = LDESClient.createReadStream(this.ldesIRI, options);

    eventstreamSync.on('data', (member) => {
      console.log(member);
    });
    eventstreamSync.on('metadata', (metadata) => {
      console.log(metadata);

      console.log(metadata.url); // page from where metadata has been extracted
      if (metadata.url !== this.ldesIRI) {
        fetch(metadata.url).then(async response => {
          // print all the members from LDES in LDP (1 layer )
          const text = await response.text();
          const rdfParser = require("rdf-parse").default;
          const streamifyString = require('streamify-string');
          const storeStream = require("rdf-store-stream").storeStream;


          const textStream = streamifyString(text);
          const quadStream = rdfParser.parse(textStream, { contentType: 'text/turtle' });
          const store = await storeStream(quadStream);
          // store.getQuads(null,'http://www.w3.org/ns/ldp#contains',null, null ).forEach(member => {
          //     console.log('   ' + metadata.url + member.object.id);

          // });

        });
      } else {
        // get highest value
        let largest = { timestamp: 0, url: '' };
        metadata.treeMetadata['relations'].forEach((element: { value: { [x: string]: any; }[]; node: { [x: string]: any; }[]; }) => {
          const datetime = element.value[0]['@value'];
          const timestamp = new Date(datetime).getTime();

          if (timestamp > largest.timestamp) {
            largest = {
              url: element.node[0]['@id'],
              timestamp: new Date(timestamp).getTime()
            };
          }
        });
      }
    });
    eventstreamSync.on('end', () => {
      this.logger.info("LDESClient finds no more data");
    });
  }


}
