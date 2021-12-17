# Curation of announcements

This library implements a class (Curator) with methods to curate an announcement LDES in LDP (e.g. [announcement LDES](https://tree.linkeddatafragments.org/announcements/)).



## Requirements

* **AnnouncementURI**: The uri of a valid LDESinLDP of announcements[^fn1]

* **SynchronizedURI**: The uri of an LDP container[^fn2]

* **CurationURI**: The uri of an LDP container[^fn2]

* Credentials for a **WebID** at an Identity Provider (IDP), that way you can create a  **[Session](https://docs.inrupt.com/developer-tools/api/javascript/solid-client-authn-browser/classes/Session.html)** and log in

  [^fn1]: Currently, the object of an announcement can only by a DCAT Dataset Application Profile, DCAT DataService Application profile or a description of an LDES view. Those interfaces are defined in the [LDES-Announcements](https://github.com/TREEcg/LDES-Announcements/blob/main/src/util/Interfaces.ts) package.
  [^fn2]: When the LDP is a Solid pod, you need a ACL:Write grant for the WebID you are using.

  

## Flow to curate the contents of an announcement

### Log in

Log in with your webID to retrieve credentials[^fn3]. With those credentials, create a Session and log in. 
Now an object of the class **Curator** can be created. 

Adding or rejecting the contents of an announcement to a curated EventStream is done with an object of the Curator class.

[^fn3]: In the package LDES-Ochestrator, there is script which can generate such credentials.

```typescript
const session = new Session();
session.onNewRefreshToken((newToken) => {
  console.log("New refresh token: ", newToken);
});
await session.login({
  clientId: credentials.clientId,
  clientSecret: credentials.clientSecret,
  refreshToken: credentials.refreshToken,
  oidcIssuer: credentials.issuer,
});

const announcementIRI = 'https://tree.linkeddatafragments.org/announcements/';
const curatedIRI = 'https://tree.linkeddatafragments.org/datasets/curated/';
const synchronizedIRI = 'https://tree.linkeddatafragments.org/datasets/synced/';

const config = {
  ldesIRI: rootIRI,
  curatedIRI: curatedIRI,
  synchronizedIRI: synchronizedIRI
};
const curator = new Curator(config, session);

```

### Synchronise

The first thing that has to be created using the Curator object is to synchronize with the announcement-LDES.

Synchronizing fetches all the ids of the members within the announcement LDES and stores them in a collection (the **Synchronized Collection**). This Synchronized collection contains the state of the curation process. It consists of all members of the LDES announcements minus the announcements that we don't care about or were accepted to the Curated LDES already.

```typescript
// synchronizing with announcement LDES
await curator.synchronize();
```

**NOTE:** The synchronize method uses the [LDESClient](https://github.com/brechtvdv/event-stream-client). Only when this client has fully streamed the LDES and updated the synchronized LDES, should curation occur. Otherwise the most recent announcements will not be the actual most recent ones.

### Initialize

The initialisation of the curation means that a curated LDP will be created if it does not exist yet. It is required that before you start accepting or rejecting the content of an announcement, the Curator object is initaliased.

```typescript
// loading the state of the Curation LDES (and creating it if it does not exist yet)
await curator.init()
```

### Curation

Curation is done using the URI of an announcement.

#### Accepting

```typescript
const uri = "...";
await curator.accept(uri)
```

When previously the uri was already fetched (and extracted to its value), it is possible to accept without fetching and extracting the contents again. For this the member contents, iri and timestamp have to be given to the accept method.



```typescript
const uri = "...";
const member = {}; // already fetched previously
const timestamp = 123456789; // already fetched previously
await curator.accept(uri, member, timestamp);
```

#### Rejecting

```typescript
const uri = "...";
await curator.reject(uri)
```

Again, slightly more bandwidth efficient.

```typescript
const uri = "...";
const timestamp = 123456789; // already fetched previously
await curator.reject(uri, timestamp);
```

## Notes

Currently it is possible to reject the same member multiple times
Also accepting the same member multiple is possible. Especially when accepting this is not allowed

Can be fixed by checking before an accept in the collection if it exists in the syncrhonized collection. Only when it's in there, it should be added to the curated ldes.
