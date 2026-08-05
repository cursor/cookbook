#!/usr/bin/env perl
use strict;
use warnings;
use FindBin;
use lib "$FindBin::Bin/lib";
use CursorSdk;

my $prompt = $ENV{CURSOR_PROMPT}
  // 'Explain this project in one paragraph.';
my $workspace = $ENV{CURSOR_WORKSPACE} // $FindBin::Bin . '/../..';
my $model     = $ENV{CURSOR_MODEL};

die "error: set CURSOR_API_KEY (https://cursor.com/dashboard)\n"
  unless $ENV{CURSOR_API_KEY};

my $client = CursorSdk::Client->new(
    workspace => $workspace,
    bridge    => $ENV{CURSOR_SDK_BRIDGE_BIN},
);

my $version = $client->version;
print "bridge $version->{bridgeVersion} protocol $version->{protocolVersion}\n";

my $agent = $client->create_agent(
    model => $model,
    cwd   => $workspace,
);
print "agent created: @{[$agent->id]} (model @{[$agent->model]})\n";

my $run = $agent->send($prompt);
for my $event ( $run->events ) {
    my $line = describe($event) or next;
    print "$line\n";
}
my $result = $run->wait;
print "run finished: status=$result->{status} duration=$result->{duration_ms}ms\n";
if ( $result->{ok} && $result->{text} ) {
    print "final result:\n$result->{text}\n";
}
elsif ( !$result->{ok} ) {
    print "error: $result->{error_message}\n" if $result->{error_message};
}

$agent->close;
$client->shutdown;
print "bridge stopped\n";

sub describe {
    my ($event) = @_;
    my $type    = $event->{type}    // '';
    my $payload = $event->{payload} // {};
    if ( $type eq 'system' ) {
        return '[system] run started: ' . ( $payload->{run_id} // $payload->{runId} // '?' );
    }
    if ( $type eq 'assistant' ) {
        my $blocks = $payload->{message}{content} // [];
        my $text = join '',
          map { $_->{text} // '' }
          grep { ref($_) eq 'HASH' && ( $_->{type} // '' ) eq 'text' } @$blocks;
        return length($text) ? "[assistant] $text" : undef;
    }
    if ( $type eq 'tool_call' ) {
        return sprintf '[tool_call %s] %s',
          $payload->{status} // '',
          $payload->{name}   // '';
    }
    if ( $type eq 'status' ) {
        return sprintf '[status %s] %s',
          $payload->{status}  // '',
          $payload->{message} // '';
    }
    return "[$type]";
}
