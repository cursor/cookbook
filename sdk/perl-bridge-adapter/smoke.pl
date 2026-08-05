#!/usr/bin/env perl
use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/lib";
use CursorSdk;

my $client = CursorSdk::Client->new(
    workspace => $FindBin::Bin,
    bridge    => $ENV{CURSOR_SDK_BRIDGE_BIN},
    api_key   => $ENV{CURSOR_API_KEY} // '',
);

my $pong = $client->ping;
print "ping: $pong->{message}\n";

my $version = $client->version;
print "version: bridge=$version->{bridgeVersion} protocol=$version->{protocolVersion}\n";

$client->shutdown;
print "ok\n";
